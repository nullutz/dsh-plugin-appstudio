import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { DeviceRole } from '../shared/protocol.ts'

export type OpenSignaling = (role: DeviceRole, signal?: AbortSignal) => RemoteStreamHandle<string, string>

export type DeviceInput =
  | { kind: 'touch'; x: number; y: number; pressure: 0 | 1 }
  | { kind: 'key'; key: string; action: 0 | 1 }

export type PeerState =
  | { phase: 'connecting' | 'ready' }
  | { phase: 'disconnected'; detail: string }

interface JsepFrame {
  type?: RTCSdpType
  sdp?: string | RTCSessionDescriptionInit
  candidate?: string | RTCIceCandidateInit
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
  appStudioInputReady?: boolean
  appStudioInputAck?: boolean
  appStudioInputError?: string
}

export interface DevicePeer {
  send(input: DeviceInput): void
  close(): void
}

export function openPeer(
  signaling: OpenSignaling,
  role: DeviceRole,
  video: HTMLVideoElement,
  retained: HTMLCanvasElement,
  onState: (state: PeerState) => void,
  onInputError: (detail: string) => void,
  shouldAnnounceReadiness: () => boolean,
): DevicePeer {
  const controller = new AbortController()
  const connection = new RTCPeerConnection({ iceServers: [] })
  let stream: ReturnType<OpenSignaling> | undefined
  let media: MediaStream | undefined
  let frameRequest: number | undefined
  let decoded = false
  let inputReady = false
  let ready = false
  const incoming: RTCIceCandidateInit[] = []
  const outgoing: RTCIceCandidateInit[] = []
  let localDescriptionSent = false
  const timeout = window.setTimeout(() => fail('Timed out waiting for video and input.'), 30_000)

  function close(): void {
    if (controller.signal.aborted) return
    controller.abort()
    window.clearTimeout(timeout)
    stream?.dispose()
    if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest)
    video.removeEventListener('loadeddata', decodeFrame)
    try {
      if (decoded && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        retained.width = video.videoWidth
        retained.height = video.videoHeight
        retained.getContext('2d')?.drawImage(video, 0, 0)
      }
    } catch {
      // The video element can lose its frame while the connection is closing.
    } finally {
      connection.close()
      video.srcObject = null
    }
  }

  function fail(error: unknown): void {
    if (controller.signal.aborted) return
    close()
    onState({ phase: 'disconnected', detail: error instanceof Error ? error.message : String(error) })
  }

  function checkReady(): void {
    if (ready || !decoded || !inputReady || connection.connectionState !== 'connected') return
    try {
      if (shouldAnnounceReadiness()) send({ appStudioPreviewReady: true })
    } catch (error) {
      fail(error)
      return
    }
    ready = true
    window.clearTimeout(timeout)
    onState({ phase: 'ready' })
  }

  function decodeFrame(): void {
    if (controller.signal.aborted || !media || video.srcObject !== media || !video.videoWidth || !video.videoHeight) return
    decoded = true
    checkReady()
  }

  function send(frame: object): void {
    if (!stream) throw new Error('Android signaling has not opened.')
    stream.send(JSON.stringify(frame))
  }

  connection.onconnectionstatechange = () => {
    if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
      fail(`Android WebRTC connection ${connection.connectionState}.`)
    } else if (connection.connectionState === 'disconnected') {
      fail('Android WebRTC connection lost.')
    } else {
      checkReady()
    }
  }
  connection.ontrack = ({ track }) => {
    if (track.kind !== 'video' || controller.signal.aborted) return
    video.addEventListener('loadeddata', decodeFrame)
    media = new MediaStream([track])
    video.srcObject = media
    void video.play().catch(fail)
    if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest)
    frameRequest = video.requestVideoFrameCallback(decodeFrame)
    track.onended = () => fail('Android video track ended.')
  }
  connection.onicecandidate = ({ candidate }) => {
    if (!candidate || controller.signal.aborted) return
    const frame = candidate.toJSON()
    try {
      if (localDescriptionSent) send(frame)
      else outgoing.push(frame)
    } catch (error) {
      fail(error)
    }
  }

  async function receive(): Promise<void> {
    stream = signaling(role, controller.signal)
    for await (const message of stream) {
      if (controller.signal.aborted) return
      const frame = JSON.parse(message) as JsepFrame
      if (frame.appStudioInputReady === true) {
        inputReady = true
        checkReady()
      } else if (frame.appStudioInputAck === true) {
        onInputError('')
      } else if (frame.appStudioInputError) {
        onInputError(frame.appStudioInputError)
      } else if (frame.sdp) {
        const description = typeof frame.sdp === 'string' && frame.type
          ? { type: frame.type, sdp: frame.sdp }
          : frame.sdp
        if (typeof description === 'string' || description.type !== 'offer') continue
        localDescriptionSent = false
        await connection.setRemoteDescription(description)
        for (const candidate of incoming.splice(0)) await connection.addIceCandidate(candidate)
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        if (controller.signal.aborted) return
        send(answer)
        localDescriptionSent = true
        for (const candidate of outgoing.splice(0)) send(candidate)
      } else if (frame.candidate) {
        const { sdpMid, sdpMLineIndex, usernameFragment } = frame
        const candidate = typeof frame.candidate === 'string'
          ? { candidate: frame.candidate, sdpMid, sdpMLineIndex, usernameFragment }
          : frame.candidate
        if (connection.remoteDescription) await connection.addIceCandidate(candidate)
        else incoming.push(candidate)
      }
    }
    fail('Android signaling closed.')
  }

  void receive().catch(fail)
  return {
    send(input) {
      if (controller.signal.aborted || !ready) return
      try {
        send({ appStudioInput: input })
      } catch (error) {
        fail(error)
      }
    },
    close,
  }
}
