import type { IterationComment, IterationSelection } from '../shared/protocol.ts'

export type DevicePoint = { x: number; y: number }
export type CapturedComment = Omit<IterationComment, 'id' | 'text'>
const maxFrameLength = 160_000

export function videoGeometry(video: HTMLVideoElement) {
  const rect = video.getBoundingClientRect()
  const { videoWidth, videoHeight } = video
  if (!videoWidth || !videoHeight || !rect.width || !rect.height) return
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight)
  return {
    rect, scale, videoWidth, videoHeight,
    insetX: (rect.width - videoWidth * scale) / 2,
    insetY: (rect.height - videoHeight * scale) / 2,
  }
}

export function locate(clientX: number, clientY: number, video: HTMLVideoElement, drag: boolean): DevicePoint | undefined {
  const geometry = videoGeometry(video)
  if (!geometry) return
  const { rect, scale, insetX, insetY, videoWidth, videoHeight } = geometry
  const x = Math.floor((clientX - rect.left - insetX) / scale)
  const y = Math.floor((clientY - rect.top - insetY) / scale)
  if (!drag && (x < 0 || y < 0 || x >= videoWidth || y >= videoHeight)) return
  return {
    x: Math.max(0, Math.min(x, videoWidth - 1)),
    y: Math.max(0, Math.min(y, videoHeight - 1)),
  }
}

export function selectionBetween(start: DevicePoint, end: DevicePoint, area: boolean): IterationSelection {
  if (!area) return { kind: 'point', ...start, width: 1, height: 1 }
  return {
    kind: 'area',
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x) + 1,
    height: Math.abs(start.y - end.y) + 1,
  }
}

export function captureComment(video: HTMLVideoElement, selection: IterationSelection): CapturedComment | undefined {
  const { videoWidth: frameWidth, videoHeight: frameHeight } = video
  if (!frameWidth || !frameHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
  const canvas = video.ownerDocument.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return

  for (const maxDimension of [960, 640, 400]) {
    const scale = Math.min(1, maxDimension / Math.max(frameWidth, frameHeight))
    canvas.width = Math.max(1, Math.round(frameWidth * scale))
    canvas.height = Math.max(1, Math.round(frameHeight * scale))
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const frame = canvas.toDataURL('image/jpeg', 0.72)
    if (frame.startsWith('data:image/jpeg;base64,') && frame.length <= maxFrameLength) {
      return { selection, frame, frameWidth, frameHeight }
    }
  }
}
