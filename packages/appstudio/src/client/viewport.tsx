import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeviceRole, IterationSelection } from '../shared/protocol.ts'
import { captureComment, locate, selectionBetween, videoGeometry, type CapturedComment, type DevicePoint } from './annotations.ts'
import type { namespace } from './copy.ts'
import { openPeer, type DeviceInput, type DevicePeer, type OpenSignaling, type PeerState } from './peer.ts'

const roles = ['live', 'candidate'] as const
const connecting: PeerState = { phase: 'connecting' }
const retryDelays = [500, 1_500, 4_000]

function useDevice(signaling: OpenSignaling, role: DeviceRole, generation: number) {
  const video = useRef<HTMLVideoElement>(null)
  const retained = useRef<HTMLCanvasElement>(null)
  const peer = useRef<DevicePeer | null>(null)
  const [snapshot, setSnapshot] = useState({ generation, state: connecting })
  const [inputError, setInputError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const videoElement = video.current
    const retainedFrame = retained.current
    if (!videoElement || !retainedFrame) return
    let retry: number | undefined
    let failures = 0

    function connect(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
      setSnapshot({ generation, state: connecting })
      setInputError('')
      try {
        peer.current = openPeer(signaling, role, video, canvas, update, setInputError)
      } catch (error) {
        update({ phase: 'disconnected', detail: error instanceof Error ? error.message : String(error) })
      }
    }

    function update(next: PeerState): void {
      setSnapshot({ generation, state: next })
      if (next.phase === 'ready') failures = 0
      if (next.phase !== 'disconnected' || !videoElement || !retainedFrame) return
      const delay = retryDelays[failures++]
      if (delay !== undefined) retry = window.setTimeout(() => connect(videoElement, retainedFrame), delay)
    }

    connect(videoElement, retainedFrame)
    return () => {
      window.clearTimeout(retry)
      peer.current?.close()
      peer.current = null
    }
  }, [signaling, role, generation, attempt])

  const state = snapshot.generation === generation ? snapshot.state : connecting
  return { video, retained, peer, generation, state, inputError, reconnect: () => setAttempt(value => value + 1) }
}

export type ReadyPreview = { role: DeviceRole; deploymentId?: string }

type ViewportProps = PropsLocale<typeof namespace> & {
  signaling: OpenSignaling
  targetRole?: DeviceRole
  targetDeployment?: string
  managed: boolean
  onSelectedRole: (role: DeviceRole) => void
  onReady?: (preview: ReadyPreview | undefined) => void
  commentingEnabled: boolean
  canAnnotate: boolean
  commentMode: boolean
  onToggleCommentMode: () => void
  onCapture: (capture: CapturedComment) => void
}
type Touch = Extract<DeviceInput, { kind: 'touch' }>
type AnnotationGesture = {
  id: number
  start: DevicePoint
  clientX: number
  clientY: number
  width: number
  height: number
  selection: IterationSelection
}

export function Viewport({
  signaling, t, targetRole, targetDeployment, managed, onSelectedRole, onReady,
  commentingEnabled, canAnnotate, commentMode, onToggleCommentMode, onCapture,
}: ViewportProps) {
  const [handoff, setHandoff] = useState({ role: targetRole, deployment: targetDeployment, generations: { live: 0, candidate: 0 } })
  const live = useDevice(signaling, 'live', handoff.generations.live)
  const candidate = useDevice(signaling, 'candidate', handoff.generations.candidate)
  const devices = { live, candidate }
  const [active, setActive] = useState<DeviceRole>(targetRole ?? 'live')
  const screen = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ id: number; last: Touch } | null>(null)
  const annotation = useRef<AnnotationGesture | null>(null)
  const [overlay, setOverlay] = useState<IterationSelection>()
  const [captureFailed, setCaptureFailed] = useState(false)
  const keys = useRef(new Map<string, string>())
  const current = devices[active]
  const interactive = current.state.phase === 'ready'
  const targetReady = interactive &&
    (!targetRole || (active === targetRole && handoff.role === targetRole && handoff.deployment === targetDeployment))

  useEffect(() => onSelectedRole(active), [active, onSelectedRole])
  useEffect(() => {
    onReady?.(targetReady ? { role: active, deploymentId: targetDeployment } : undefined)
  }, [active, onReady, targetDeployment, targetReady])

  useEffect(() => {
    if (interactive) return
    keys.current.clear()
    const drag = pointer.current
    pointer.current = null
    if (drag && screen.current?.hasPointerCapture(drag.id)) screen.current.releasePointerCapture(drag.id)
    clearAnnotation()
  }, [interactive])

  useLayoutEffect(() => {
    if (commentMode) releaseInput()
    if (!commentMode || !canAnnotate) clearAnnotation()
  }, [commentMode, canAnnotate])

  function send(input: DeviceInput): void {
    if (interactive) current.peer.current?.send(input)
  }

  function releasePointer(): void {
    const drag = pointer.current
    if (!drag) return
    pointer.current = null
    send({ ...drag.last, pressure: 0 })
    if (screen.current?.hasPointerCapture(drag.id)) screen.current.releasePointerCapture(drag.id)
  }

  function releaseInput(): void {
    releasePointer()
    for (const key of keys.current.values()) send({ kind: 'key', key, action: 1 })
    keys.current.clear()
  }

  function clearAnnotation(): void {
    const drag = annotation.current
    if (!drag) return
    annotation.current = null
    setOverlay(undefined)
    if (screen.current?.hasPointerCapture(drag.id)) screen.current.releasePointerCapture(drag.id)
  }

  useLayoutEffect(() => {
    if (handoff.role !== targetRole || handoff.deployment !== targetDeployment) {
      // The previous target peer may have decoded a frame before this deployment.
      if (targetRole === active && targetDeployment) {
        releaseInput()
        clearAnnotation()
      }
      const generations = targetRole && (targetRole !== active || targetDeployment)
        ? { ...handoff.generations, [targetRole]: handoff.generations[targetRole] + 1 }
        : handoff.generations
      setHandoff({ role: targetRole, deployment: targetDeployment, generations })
      return
    }
    if (!targetRole || targetRole === active || devices[targetRole].state.phase !== 'ready') return
    releaseInput()
    clearAnnotation()
    setActive(targetRole)
  })

  function pointerDown(event: PointerEvent<HTMLDivElement>): void {
    const video = current.video.current
    if (event.button !== 0 || pointer.current || annotation.current || !interactive || !video) return
    if (commentMode && !canAnnotate) return
    const point = locate(event.clientX, event.clientY, video, false)
    if (!point) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    if (commentMode) {
      const selection = selectionBetween(point, point, false)
      annotation.current = {
        id: event.pointerId, start: point, clientX: event.clientX, clientY: event.clientY,
        width: video.videoWidth, height: video.videoHeight, selection,
      }
      setCaptureFailed(false)
      setOverlay(selection)
      return
    }
    const last: Touch = { kind: 'touch', ...point, pressure: 1 }
    pointer.current = { id: event.pointerId, last }
    send(last)
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>): void {
    const video = current.video.current
    if (!interactive || !video) return
    const selectionDrag = annotation.current
    if (selectionDrag?.id === event.pointerId) {
      if (selectionDrag.width !== video.videoWidth || selectionDrag.height !== video.videoHeight) {
        clearAnnotation()
        return
      }
      const end = locate(event.clientX, event.clientY, video, true)
      if (!end) return
      const area = selectionDrag.selection.kind === 'area' ||
        Math.hypot(event.clientX - selectionDrag.clientX, event.clientY - selectionDrag.clientY) >= 5
      selectionDrag.selection = selectionBetween(selectionDrag.start, end, area)
      setOverlay(selectionDrag.selection)
      return
    }
    const drag = pointer.current
    if (drag?.id !== event.pointerId) return
    const point = locate(event.clientX, event.clientY, video, true)
    if (!point || (point.x === drag.last.x && point.y === drag.last.y)) return
    drag.last = { kind: 'touch', ...point, pressure: 1 }
    send(drag.last)
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (annotation.current?.id === event.pointerId) {
      pointerMove(event)
      const selection = annotation.current?.selection
      const video = current.video.current
      clearAnnotation()
      if (!selection || !video || !interactive || !canAnnotate) return
      try {
        const capture = captureComment(video, selection)
        if (capture) onCapture(capture)
        else setCaptureFailed(true)
      } catch {
        setCaptureFailed(true)
      }
      return
    }
    if (pointer.current?.id !== event.pointerId) return
    pointerMove(event)
    releasePointer()
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (commentMode) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onToggleCommentMode()
      }
      return
    }
    if (!interactive || event.nativeEvent.isComposing || (event.shiftKey && event.key === 'Tab')) return
    if (event.key === 'Unidentified' || event.key === 'Dead' || event.key === 'Process') return
    event.preventDefault()
    event.stopPropagation()
    const key = keys.current.get(event.code) ?? (event.key === 'Escape' ? 'GoBack' : event.key)
    keys.current.set(event.code, key)
    send({ kind: 'key', key, action: 0 })
  }

  function keyUp(event: KeyboardEvent<HTMLDivElement>): void {
    const key = keys.current.get(event.code)
    if (!key) return
    event.preventDefault()
    event.stopPropagation()
    keys.current.delete(event.code)
    send({ kind: 'key', key, action: 1 })
  }

  function select(role: DeviceRole): void {
    if (devices[role].state.phase !== 'ready') return
    releaseInput()
    setActive(role)
    screen.current?.focus()
  }

  const geometry = overlay && current.video.current && videoGeometry(current.video.current)

  return (
    <section className="appstudio-devices" aria-label={t('subtitle')}>
      <div className="appstudio-device-tabs">
        {roles.map(role => {
          const device = devices[role]
          return (
            <div key={role} className="appstudio-device-tab">
              {managed
                ? <strong>{t(active === role ? 'projectLiveDevice' : 'projectBackgroundDevice')}</strong>
                : (
                  <button
                    type="button"
                    data-appstudio-switch={role}
                    aria-pressed={active === role}
                    disabled={device.state.phase !== 'ready'}
                    onClick={() => select(role)}
                  >
                    {t(role)}
                  </button>
                )}
              <span aria-live="polite">{t(device.state.phase)}</span>
              {device.state.phase === 'disconnected' && (
                <button type="button" onClick={() => {
                  if (role === active) releaseInput()
                  device.reconnect()
                }}>
                  {t('reconnect')}
                </button>
              )}
            </div>
          )
        })}
        {commentingEnabled && (
          <button
            type="button"
            data-appstudio-comment-mode=""
            aria-pressed={commentMode}
            disabled={!commentMode && (!canAnnotate || !interactive)}
            onClick={onToggleCommentMode}
          >
            {t(commentMode ? 'commentModeExit' : 'commentMode')}
          </button>
        )}
      </div>
      <div
        className="appstudio-screen"
        data-appstudio-viewport=""
        data-appstudio-active={active}
        data-comment-mode={commentMode}
        ref={screen}
        tabIndex={0}
        aria-label={t('viewport')}
        onBlur={() => { releaseInput(); clearAnnotation() }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={event => {
          if (pointer.current?.id === event.pointerId) releasePointer()
          if (annotation.current?.id === event.pointerId) clearAnnotation()
        }}
        onLostPointerCapture={event => {
          if (pointer.current?.id === event.pointerId) releasePointer()
          if (annotation.current?.id === event.pointerId) clearAnnotation()
        }}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
      >
        {roles.map(role => {
          const device = devices[role]
          const show = active === role
          return (
            <div key={role} aria-hidden="true" className="appstudio-feed" data-selected={show} data-ready={device.state.phase === 'ready'}>
              <canvas ref={device.retained} />
              <video key={device.generation} ref={device.video} data-appstudio-device={role} autoPlay muted playsInline />
            </div>
          )
        })}
        {overlay && geometry && (
          <span
            aria-hidden="true"
            className="appstudio-selection"
            data-kind={overlay.kind}
            style={{
              left: `${(geometry.insetX + overlay.x * geometry.scale) / geometry.rect.width * 100}%`,
              top: `${(geometry.insetY + overlay.y * geometry.scale) / geometry.rect.height * 100}%`,
              width: overlay.kind === 'area' ? `${overlay.width * geometry.scale / geometry.rect.width * 100}%` : undefined,
              height: overlay.kind === 'area' ? `${overlay.height * geometry.scale / geometry.rect.height * 100}%` : undefined,
            }}
          />
        )}
      </div>
      {targetRole && targetRole !== active && (
        <p className="appstudio-device-status" data-appstudio-handoff="waiting" role="status">{t('projectHandoffWaiting')}</p>
      )}
      <p className="appstudio-device-status" aria-live="polite">
        {current.state.phase === 'disconnected'
          ? current.state.detail
          : interactive ? commentMode ? t('commentModeHint') : current.inputError || t('inputHint') : t('viewportEmpty')}
      </p>
      {commentMode && captureFailed && <p className="appstudio-device-status" role="alert">{t('commentCaptureFailed')}</p>}
    </section>
  )
}
