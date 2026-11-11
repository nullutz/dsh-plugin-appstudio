import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AndroidDevice, DeviceRole, IterationSelection } from '../shared/protocol.ts'
import { captureComment, locate, selectionBetween, videoGeometry, type CapturedComment, type DevicePoint } from './annotations.ts'
import type { namespace } from './copy.ts'
import { StudioIcon } from './icons.tsx'
import type { DeviceInput } from './peer.ts'
import { previewRoles, type PreviewSession } from './preview.ts'

type ViewportProps = PropsLocale<typeof namespace> & {
  heading?: ReactNode
  preview: PreviewSession
  availableDevices: readonly AndroidDevice[]
  backgroundFailed: boolean
  managed: boolean
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
  heading, preview, availableDevices, backgroundFailed, t, managed,
  commentingEnabled, canAnnotate, commentMode, onToggleCommentMode, onCapture,
}: ViewportProps) {
  const { selectedRole: active, deployedRole, feeds: devices, handingOff } =
    useSyncExternalStore(preview.subscribe, preview.getSnapshot)
  const media = useRef<HTMLDivElement>(null)
  const releaseOnDetach = useRef<() => void>(() => {})
  const screen = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ id: number; last: Touch } | null>(null)
  const annotation = useRef<AnnotationGesture | null>(null)
  const [overlay, setOverlay] = useState<IterationSelection>()
  const [captureFailed, setCaptureFailed] = useState(false)
  const keys = useRef(new Map<string, string>())
  const current = devices[active]
  const interactive = current.state.phase === 'ready'

  releaseOnDetach.current = () => {
    releaseInput()
    clearAnnotation()
  }
  useLayoutEffect(() => {
    if (media.current) return preview.attach(media.current, () => releaseOnDetach.current())
  }, [preview])

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
    if (interactive) preview.send(active, input)
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

  function pointerDown(event: PointerEvent<HTMLDivElement>): void {
    const video = preview.video(active)
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
    const video = preview.video(active)
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
      const video = preview.video(active)
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
    clearAnnotation()
    if (role !== active && commentMode) onToggleCommentMode()
    preview.select(role)
    screen.current?.focus()
  }

  const video = preview.video(active)
  const geometry = overlay && video && videoGeometry(video)

  return (
    <section className="appstudio-devices" aria-label={t('subtitle')}>
      <div className="appstudio-device-bar">
        {heading}
        <div className="appstudio-device-tabs">
          {previewRoles.map(role => {
            const device = devices[role]
            const label = role === deployedRole ? 'projectLiveDevice' : 'projectBackgroundDevice'
            const available = availableDevices.some(device => device.id === role)
            const status = available ? device.state.phase : backgroundFailed ? 'projectDeviceFailed' : 'projectDeviceStarting'
            return (
              <div key={role} className="appstudio-device-tab" data-state={status}>
                <button
                  type="button"
                  data-appstudio-switch={role}
                  aria-pressed={active === role}
                  disabled={!available || device.state.phase !== 'ready'}
                  onClick={() => select(role)}
                >
                  {t(managed ? label : role)}
                </button>
                <span aria-live="polite">{t(status)}</span>
                {available && device.state.phase === 'disconnected' && (
                  <button type="button" onClick={() => {
                    if (role === active) releaseInput()
                    preview.reconnect(role)
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
              className="appstudio-comment-toggle"
              data-appstudio-comment-mode=""
              aria-pressed={commentMode}
              disabled={!commentMode && (!canAnnotate || !interactive)}
              onClick={onToggleCommentMode}
            >
              <StudioIcon name="comment" size={18} />
              {t(commentMode ? 'commentModeExit' : 'commentMode')}
            </button>
          )}
        </div>
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
        <div className="appstudio-media" ref={media} />
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
      {handingOff && (
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
