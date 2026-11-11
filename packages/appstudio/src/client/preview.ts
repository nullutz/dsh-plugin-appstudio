import type { DeviceRole } from '../shared/protocol.ts'
import { openPeer, type DeviceInput, type DevicePeer, type OpenSignaling, type PeerState } from './peer.ts'

export const previewRoles = ['live', 'candidate'] as const
const connecting: PeerState = { phase: 'connecting' }
const retryDelays = [500, 1_500, 4_000]
const waiting = { state: connecting, inputError: '' }

export type PreviewDeployment = { role: DeviceRole; projectRoot: string; deploymentId?: string }
export type PreviewStatus = {
  selectedRole: DeviceRole
  readyDeployment?: PreviewDeployment
  handingOff: boolean
}
type FeedState = { state: PeerState; inputError: string }
type Snapshot = PreviewStatus & {
  deployedRole: DeviceRole
  feeds: Record<DeviceRole, FeedState>
}
type Feed = {
  role: DeviceRole
  element: HTMLDivElement
  video: HTMLVideoElement
  retained: HTMLCanvasElement
  view: FeedState
  peer?: DevicePeer
  attempt: number
  failures: number
  timer?: number
}

function makeVideo(role: DeviceRole): HTMLVideoElement {
  const video = document.createElement('video')
  video.dataset.appstudioDevice = role
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  return video
}

function sameTarget(left?: PreviewDeployment, right?: PreviewDeployment): boolean {
  return left?.role === right?.role && left?.projectRoot === right?.projectRoot && left?.deploymentId === right?.deploymentId
}

// Keep decoded video elements with their peers. A new element can wait for a
// new frame from a static screen even when the incoming MediaStream is reused.
export class PreviewSession {
  private feeds = new Map<DeviceRole, Feed>()
  private listeners = new Set<() => void>()
  private parking?: HTMLDivElement
  private surface?: { host: HTMLDivElement; release: () => void }
  private target?: PreviewDeployment
  private readinessRole?: DeviceRole
  private published?: PreviewDeployment
  private selected: DeviceRole = 'live'
  private pending = false
  private snapshot: Snapshot = {
    selectedRole: 'live', deployedRole: 'live', handingOff: false, feeds: { live: waiting, candidate: waiting },
  }

  constructor(private signaling: OpenSignaling) {}

  getSnapshot = (): Snapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  attach(host: HTMLDivElement, release: () => void): () => void {
    const surface = { host, release }
    this.surface?.release()
    this.surface = surface
    for (const feed of this.feeds.values()) this.place(feed.element)
    return () => {
      if (this.surface !== surface) return
      surface.release()
      this.surface = undefined
      for (const feed of this.feeds.values()) this.place(feed.element)
    }
  }

  configure(roles: readonly DeviceRole[], target?: PreviewDeployment, readinessRole?: DeviceRole): void {
    this.readinessRole = readinessRole
    const before = this.feeds.size
    const changed = !sameTarget(this.target, target)
    const newFeeds: Feed[] = []
    let removed = false
    for (const [role, feed] of this.feeds) {
      if (roles.includes(role)) continue
      if (role === this.selected) this.surface?.release()
      this.close(feed)
      feed.element.remove()
      this.feeds.delete(role)
      removed = true
    }
    if (!this.feeds.has(this.selected)) {
      this.selected = target && roles.includes(target.role) ? target.role : roles[0] ?? 'live'
    }
    for (const role of roles) {
      if (this.feeds.has(role)) continue
      const element = document.createElement('div')
      element.className = 'appstudio-feed'
      element.setAttribute('aria-hidden', 'true')
      const video = makeVideo(role)
      const retained = document.createElement('canvas')
      element.append(retained, video)
      const feed = { role, element, video, retained, view: waiting, attempt: 0, failures: 0 }
      this.feeds.set(role, feed)
      this.place(element)
      newFeeds.push(feed)
    }

    if (changed) {
      this.target = target
      this.pending = !!target
      if (!target) this.published = undefined
      const feed = target && this.feeds.get(target.role)
      if (feed && before && !newFeeds.includes(feed)) this.restart(feed, true)
    }
    for (const feed of newFeeds) this.connect(feed)
    if (changed || newFeeds.length || removed) this.update()
  }

  select(role: DeviceRole): void {
    if (this.selected === role || this.feeds.get(role)?.view.state.phase !== 'ready') return
    this.surface?.release()
    this.selected = role
    this.update()
  }

  reconnect(role: DeviceRole): void {
    const feed = this.feeds.get(role)
    if (feed) this.restart(feed, false)
  }

  video(role: DeviceRole): HTMLVideoElement | undefined {
    return this.feeds.get(role)?.video
  }

  send(role: DeviceRole, input: DeviceInput): void {
    const feed = this.feeds.get(role)
    if (feed?.view.state.phase === 'ready') feed.peer?.send(input)
  }

  reset(): void {
    if (!this.feeds.size && !this.target && !this.parking) return
    this.surface?.release()
    for (const feed of this.feeds.values()) {
      this.close(feed)
      feed.element.remove()
    }
    this.feeds.clear()
    this.parking?.remove()
    this.parking = undefined
    this.target = undefined
    this.readinessRole = undefined
    this.published = undefined
    this.selected = 'live'
    this.pending = false
    this.update()
  }

  private place(element: HTMLDivElement): void {
    const parent = this.surface?.host ?? this.parkingArea()
    if (element.parentNode === parent) return
    if (parent.isConnected && element.isConnected && typeof parent.moveBefore === 'function') {
      parent.moveBefore(element, null)
    } else {
      parent.append(element)
    }
  }

  private parkingArea(): HTMLDivElement {
    if (!this.parking) {
      const parking = document.createElement('div')
      parking.setAttribute('aria-hidden', 'true')
      parking.style.cssText = 'position:fixed;inset:0 auto auto -10000px;width:1px;height:1px;overflow:hidden;pointer-events:none'
      document.body.append(parking)
      this.parking = parking
    }
    return this.parking
  }

  private close(feed: Feed): void {
    feed.attempt++
    window.clearTimeout(feed.timer)
    feed.timer = undefined
    feed.peer?.close()
    feed.peer = undefined
  }

  private restart(feed: Feed, freshFrame: boolean): void {
    if (feed.role === this.selected) this.surface?.release()
    this.close(feed)
    feed.failures = 0
    if (freshFrame) {
      const video = makeVideo(feed.role)
      feed.video.replaceWith(video)
      feed.video = video
    }
    this.connect(feed)
  }

  private connect(feed: Feed): void {
    const attempt = ++feed.attempt
    feed.view = waiting
    this.update()
    const onState = (state: PeerState): void => {
      if (feed.attempt !== attempt) return
      feed.view = { ...feed.view, state }
      if (state.phase === 'ready') feed.failures = 0
      if (state.phase === 'disconnected') {
        const delay = retryDelays[feed.failures++]
        if (delay !== undefined) feed.timer = window.setTimeout(() => {
          if (feed.attempt === attempt) this.connect(feed)
        }, delay)
      }
      this.update()
    }
    try {
      feed.peer = openPeer(this.signaling, feed.role, feed.video, feed.retained, onState, inputError => {
        if (feed.attempt !== attempt || feed.view.inputError === inputError) return
        feed.view = { ...feed.view, inputError }
        this.update()
      }, () => feed.role === this.readinessRole)
    } catch (error) {
      onState({ phase: 'disconnected', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  private update(): void {
    const target = this.target
    if (this.pending && target && this.feeds.get(target.role)?.view.state.phase === 'ready') {
      this.surface?.release()
      this.selected = target.role
      this.published = target
      this.pending = false
    }
    for (const [role, feed] of this.feeds) {
      feed.element.dataset.selected = String(role === this.selected)
      feed.element.dataset.ready = String(feed.view.state.phase === 'ready')
    }
    const published = this.published
    this.snapshot = {
      selectedRole: this.selected,
      readyDeployment: published && this.feeds.get(published.role)?.view.state.phase === 'ready' ? published : undefined,
      handingOff: this.pending,
      deployedRole: published?.role ?? target?.role ?? 'live',
      feeds: { live: this.feeds.get('live')?.view ?? waiting, candidate: this.feeds.get('candidate')?.view ?? waiting },
    }
    for (const listener of this.listeners) listener()
  }
}
