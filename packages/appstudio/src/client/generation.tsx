import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { FrameworkId, GenerationMode, GenerationRequest, GenerationView } from '../shared/protocol.ts'
import type { namespace } from './copy.ts'
import { StudioIcon } from './icons.tsx'
import { canGenerateLayout, LayoutEditor, newStarterLayout, starterBlockKinds } from './layout.tsx'

export interface GenerationRemote {
  generationStatus(projectRoot: string): Promise<RemoteResult<GenerationView | null>>
  submitGeneration(request: GenerationRequest): Promise<RemoteResult<GenerationView>>
}

const receiptKey = 'dsh-appstudio.generation-request'
const absoluteProject = /^[a-z]:[\\/]/iu
type LocalRequest = Omit<GenerationRequest, 'batchId'>
type ObservedGeneration = { root: string; view: GenerationView | null; requestedBatch?: string }

function readReceipt(): GenerationRequest | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(receiptKey) ?? 'null') as GenerationRequest | null
    if (!value || typeof value.batchId !== 'string' || typeof value.projectRoot !== 'string' ||
        !absoluteProject.test(value.projectRoot) || (value.mode !== 'layout' && value.mode !== 'prompt') ||
        typeof value.name !== 'string' || typeof value.brief !== 'string') return undefined
    if (value.layout !== null && (!Array.isArray(value.layout?.screens) || !value.layout.screens.length ||
        value.layout.screens.some(screen => !screen || typeof screen.id !== 'string' || typeof screen.title !== 'string' ||
          !Array.isArray(screen.blocks) || screen.blocks.some(block => !block || typeof block.id !== 'string' ||
            typeof block.text !== 'string' || !starterBlockKinds.includes(block.kind))))) {
      return undefined
    }
    return value
  } catch {
    // The Host also stores the latest job by project path.
  }
  return undefined
}

function storeReceipt(request: GenerationRequest | undefined): void {
  try {
    if (request) localStorage.setItem(receiptKey, JSON.stringify(request))
    else localStorage.removeItem(receiptKey)
  } catch {
    // A failed local write does not prevent submission.
  }
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function unfinished(view: GenerationView | null | undefined): boolean {
  return !!view && view.phase !== 'applied' && view.phase !== 'failed'
}

function comparable(request: GenerationRequest): LocalRequest {
  const { batchId: _batchId, ...fields } = request
  return fields
}

export function useGeneration(remote: GenerationRemote, path: string, enabled: boolean, visible: boolean) {
  const [receipt, setReceipt] = useState(readReceipt)
  const [latest, setLatest] = useState<ObservedGeneration>()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [statusFailure, setStatusFailure] = useState<{ root: string; message: string }>()
  const requestFence = useRef(0)
  const inFlight = useRef(false)
  const active = unfinished(latest?.view)
  const projectRoot = absoluteProject.test(path) ? path : ''
  const requestedBatch = receipt?.batchId
  const recovering = receipt && (latest?.root !== receipt.projectRoot || latest.requestedBatch !== requestedBatch)
  const root = active && latest ? latest.root : recovering ? receipt.projectRoot : projectRoot || receipt?.projectRoot || ''
  const observing = enabled && (visible || !!recovering || active)
  const view = latest?.root === root ? latest.view : undefined
  const result = receipt && latest?.view?.batchId === receipt.batchId && latest.view.phase === 'applied' ? latest.view : undefined
  const statusError = statusFailure?.root === root ? statusFailure.message : ''

  useEffect(() => {
    if (!observing || !root) return
    let disposed = false
    let checking = false
    async function check(): Promise<void> {
      if (disposed || checking || inFlight.current) return
      const fence = requestFence.current
      checking = true
      try {
        const value = unwrap(await remote.generationStatus(root))
        if (disposed || fence !== requestFence.current) return
        setLatest({ root, view: value, requestedBatch })
        setStatusFailure(undefined)
      } catch (cause) {
        if (!disposed && fence === requestFence.current) {
          setStatusFailure({ root, message: cause instanceof Error ? cause.message : String(cause) })
        }
      } finally {
        checking = false
      }
    }
    const initial = window.setTimeout(() => void check(), 250)
    const timer = window.setInterval(() => void check(), 2_000)
    return () => {
      disposed = true
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [observing, remote, root, requestedBatch])

  const acknowledge = useCallback((batchId: string): void => {
    if (receipt?.batchId !== batchId) return
    storeReceipt(undefined)
    setReceipt(undefined)
  }, [receipt])

  async function submit(fields: LocalRequest): Promise<void> {
    if (!enabled || inFlight.current || active) return
    const sameAttempt = receipt && view?.batchId !== receipt.batchId &&
      JSON.stringify(comparable(receipt)) === JSON.stringify(fields)
    const request = sameAttempt ? receipt : { ...fields, batchId: crypto.randomUUID() }
    inFlight.current = true
    requestFence.current++
    setReceipt(request)
    storeReceipt(request)
    setSending(true)
    setError('')
    setStatusFailure(undefined)
    try {
      setLatest({
        root: request.projectRoot, requestedBatch: request.batchId, view: unwrap(await remote.submitGeneration(request)),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  return { view, active, sending, error, statusError, result, receipt, submit, acknowledge }
}

type GenerationPanelProps = PropsLocale<typeof namespace> & {
  state: ReturnType<typeof useGeneration>
  projectRoot: string
  framework: FrameworkId | undefined
  layoutEnabled: boolean
  promptEnabled: boolean
  disabled: boolean
  onOpenSession: (id: string) => void
}

export function GenerationPanel({
  state, projectRoot, framework, layoutEnabled, promptEnabled, disabled, onOpenSession, t,
}: GenerationPanelProps) {
  const [mode, setMode] = useState<GenerationMode>(() => state.receipt?.mode ?? 'layout')
  const [name, setName] = useState(() => state.receipt?.name ?? '')
  const [brief, setBrief] = useState(() => state.receipt?.brief ?? '')
  const [layout, setLayout] = useState(() => state.receipt?.layout ?? newStarterLayout(t('starterScreenDefault')))
  const [repairNote, setRepairNote] = useState('')
  const visibleMode = mode === 'layout' ? (layoutEnabled ? 'layout' : 'prompt') : (promptEnabled ? 'prompt' : 'layout')
  const isLayout = visibleMode === 'layout'
  const busy = state.sending || state.active
  const view = state.view
  const canSubmit = !disabled && !busy && !!framework && absoluteProject.test(projectRoot) && !!name.trim() &&
    (isLayout ? canGenerateLayout(layout) : !!brief.trim())
  const mayRetry = view?.phase === 'failed' && !busy && !disabled &&
    (view.mode === 'layout' ? layoutEnabled : promptEnabled)
  const needsSetup = !framework || !absoluteProject.test(projectRoot)

  return (
    <section className="appstudio-generation appstudio-surface" aria-label={t('starterTitle')} data-appstudio-generation="">
      <header className="appstudio-surface-header">
        <div>
          <p className="appstudio-eyebrow">{t('starterKicker')}</p>
          <h2>{t('starterTitle')}</h2>
          <p>{t('starterHelp')}</p>
        </div>
        {busy && <span role="status" className="appstudio-status" data-phase="starting">{t('working')}</span>}
      </header>
      <div className="appstudio-generation-body">
        <div className="appstudio-starter-modes" role="group" aria-label={t('starterMode')}>
          {layoutEnabled && (
            <button type="button" aria-pressed={isLayout} onClick={() => setMode('layout')} disabled={busy}
              data-appstudio-generation-mode="layout">
              <span className="appstudio-mode-icon"><StudioIcon name="layout" size={19} /></span>
              <span><strong>{t('starterLayout')}</strong><small>{t('starterLayoutSummary')}</small></span>
            </button>
          )}
          {promptEnabled && (
            <button type="button" aria-pressed={!isLayout} onClick={() => setMode('prompt')} disabled={busy}
              data-appstudio-generation-mode="prompt">
              <span className="appstudio-mode-icon"><StudioIcon name="prompt" size={19} /></span>
              <span><strong>{t('starterPrompt')}</strong><small>{t('starterPromptSummary')}</small></span>
            </button>
          )}
        </div>
        <form className="appstudio-starter-form" onSubmit={event => {
          event.preventDefault()
          if (canSubmit && framework) void state.submit({
            projectRoot, framework, mode: visibleMode, name: name.trim(), brief: brief.trim(),
            layout: isLayout ? { screens: layout.screens.map(screen => ({ ...screen, title: screen.title.trim() })) } : null,
            retryOf: null, repairNote: '',
          })
        }}>
          <label className="appstudio-field">
            {t('starterName')}
            <input data-appstudio-generation-name="" value={name} maxLength={80} required disabled={busy}
              placeholder={t('starterNameExample')} onChange={event => setName(event.target.value)} />
          </label>
          {isLayout && <LayoutEditor layout={layout} onChange={setLayout} disabled={busy} t={t} />}
          <label className="appstudio-field">
            {isLayout ? t('starterOptionalBrief') : t('starterBrief')}
            <textarea data-appstudio-generation-brief="" rows={isLayout ? 3 : 7} value={brief} maxLength={4000}
              disabled={busy} required={!isLayout} onChange={event => setBrief(event.target.value)} placeholder={t('starterBriefExample')} />
          </label>
          <div className="appstudio-starter-submit">
            <div><strong>{framework ? t(framework) + ' · Android' : t('starterTarget')}</strong>
              <p>{needsSetup ? t('starterChooseProject') : t('starterValidationHelp')}</p></div>
            <button type="submit" className="appstudio-primary" data-appstudio-submit-generation="" disabled={!canSubmit}>
              {t('starterGenerate')} <StudioIcon name="arrow" size={17} />
            </button>
          </div>
        </form>
        {(state.error || state.statusError) && <p role="alert">{state.error || state.statusError}</p>}
        {view && (
          <div className="appstudio-generation-result" data-appstudio-generation-phase={view.phase}>
            <div className="appstudio-runtime-title">
              <strong role="status">{t(`generation.${view.phase}`)}</strong>
              {view.sessionId && <button type="button" data-appstudio-generation-session="" onClick={() => onOpenSession(view.sessionId!)}>
                {t('starterOpenSession')} <StudioIcon name="external" size={14} />
              </button>}
            </div>
            {view.detail && <p>{view.detail}</p>}
            {view.log && <details open={view.phase === 'failed'}>
              <summary>{t('starterLogs')}</summary>
              <pre className="appstudio-project-output" data-appstudio-generation-log="">{view.log}</pre>
            </details>}
            {mayRetry && <form className="appstudio-starter-form" onSubmit={event => {
              event.preventDefault()
              void state.submit({
                projectRoot: view.projectRoot, framework: view.framework, mode: view.mode, name: '', brief: '',
                layout: null, retryOf: view.batchId, repairNote: repairNote.trim(),
              })
            }}>
              <label className="appstudio-field">
                {t('iterationRepairNote')}
                <textarea data-appstudio-generation-repair-note="" value={repairNote} maxLength={2000}
                  onChange={event => setRepairNote(event.target.value)} />
              </label>
              <div><button type="submit" data-appstudio-retry-generation="">{t('iterationRetry')}</button></div>
            </form>}
          </div>
        )}
      </div>
    </section>
  )
}
