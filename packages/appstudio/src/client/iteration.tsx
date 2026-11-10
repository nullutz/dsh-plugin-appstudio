import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { IterationComment, IterationRequest, IterationSession, IterationView } from '../shared/protocol.ts'
import type { CapturedComment } from './annotations.ts'
import type { namespace } from './copy.ts'
import { projectDrafts, readPendingBatch, writePendingBatch, type PendingBatch } from './iteration-drafts.ts'

export interface IterationRemote {
  listIterationSessions(projectRoot: string): Promise<RemoteResult<IterationSession[]>>
  createIterationSession(projectRoot: string): Promise<RemoteResult<IterationSession>>
  iterationStatus(projectRoot: string): Promise<RemoteResult<IterationView | null>>
  submitIteration(request: IterationRequest): Promise<RemoteResult<IterationView>>
}

const maxComments = 10
const maxText = 2_000
const noComments: IterationComment[] = []
const noSessions: IterationSession[] = []
type ForProject<T> = { root: string; value: T }

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useIteration(remote: IterationRemote, projectRoot: string, commentingEnabled: boolean, iterationEnabled: boolean) {
  const [drafts, setDrafts] = useState<ForProject<IterationComment[]>>()
  const [capture, setCapture] = useState<ForProject<CapturedComment>>()
  const [recent, setRecent] = useState<ForProject<IterationSession[]>>()
  const [selected, setSelected] = useState<ForProject<string>>()
  const [latest, setLatest] = useState<ForProject<IterationView | null>>()
  const [error, setError] = useState<ForProject<string>>()
  const [statusError, setStatusError] = useState<ForProject<string>>()
  const [draftError, setDraftError] = useState<ForProject<boolean>>()
  const [sessionBusy, setSessionBusy] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const root = useRef(projectRoot)
  const statusFence = useRef(0)
  const sendInFlight = useRef(false)
  const pendingBatch = useRef(new Map<string, PendingBatch>())
  const clearingBatch = useRef(new Set<string>())

  useLayoutEffect(() => { root.current = projectRoot }, [projectRoot])

  const adopt = useCallback((path: string, value: IterationView | null) => {
    if (root.current === path) setLatest({ root: path, value })
    const pending = pendingBatch.current.get(path) ?? readPendingBatch(path)
    if (!value || !pending || pending.batchId !== value.batchId || clearingBatch.current.has(value.batchId)) return
    clearingBatch.current.add(value.batchId)
    const ids = new Set(pending.commentIds)
    void (ids.size ? projectDrafts(path, comments => comments.filter(comment => !ids.has(comment.id))) : Promise.resolve(undefined))
      .then(comments => {
        if ((pendingBatch.current.get(path) ?? readPendingBatch(path))?.batchId === value.batchId) {
          pendingBatch.current.delete(path)
          writePendingBatch(path, undefined)
        }
        if (root.current === path && comments) setDrafts({ root: path, value: comments })
      })
      .catch(() => {
        if (root.current === path) setDraftError({ root: path, value: true })
      })
      .finally(() => clearingBatch.current.delete(value.batchId))
  }, [])

  useEffect(() => {
    if (!projectRoot || (!commentingEnabled && !iterationEnabled)) return
    let disposed = false
    void projectDrafts(projectRoot).then(value => {
      if (!disposed) {
        setDrafts({ root: projectRoot, value })
        setDraftError(undefined)
      }
    }).catch(() => { if (!disposed) setDraftError({ root: projectRoot, value: true }) })
    return () => { disposed = true }
  }, [projectRoot, commentingEnabled, iterationEnabled])

  useEffect(() => {
    if (!projectRoot || !iterationEnabled) return
    let disposed = false
    let checking = false
    async function check(): Promise<void> {
      if (disposed || checking || sendInFlight.current) return
      const fence = statusFence.current
      checking = true
      try {
        const result = await remote.iterationStatus(projectRoot)
        if (disposed || fence !== statusFence.current) return
        adopt(projectRoot, unwrap(result))
        setStatusError(undefined)
      } catch (cause) {
        if (!disposed && fence === statusFence.current) {
          setStatusError({ root: projectRoot, value: errorMessage(cause) })
        }
      } finally {
        checking = false
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 2_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [adopt, iterationEnabled, projectRoot, remote])

  useEffect(() => {
    if (!projectRoot || !iterationEnabled) return
    let disposed = false
    void remote.listIterationSessions(projectRoot).then(result => {
      if (!disposed) setRecent({ root: projectRoot, value: unwrap(result) })
    }).catch(cause => {
      if (!disposed) setError({ root: projectRoot, value: errorMessage(cause) })
    })
    return () => { disposed = true }
  }, [iterationEnabled, projectRoot, remote])

  const comments = drafts?.root === projectRoot ? drafts.value : noComments
  const captured = capture?.root === projectRoot ? capture.value : undefined
  const sessions = recent?.root === projectRoot ? recent.value : noSessions
  const view = latest?.root === projectRoot ? latest.value : undefined
  const active = !!view && view.phase !== 'applied' && view.phase !== 'failed'
  const sessionId = (selected?.root === projectRoot && sessions.some(session => session.id === selected.value)
    ? selected.value
    : sessions[0]?.id) ?? ''

  async function changeDrafts(update: (items: IterationComment[]) => IterationComment[]): Promise<boolean> {
    if (draftBusy || !projectRoot) return false
    setDraftBusy(true)
    try {
      const value = await projectDrafts(projectRoot, update)
      if (root.current === projectRoot) {
        setDrafts({ root: projectRoot, value })
        setDraftError(undefined)
      }
      return true
    } catch {
      if (root.current === projectRoot) setDraftError({ root: projectRoot, value: true })
      return false
    } finally {
      setDraftBusy(false)
    }
  }

  async function saveComment(text: string): Promise<boolean> {
    const note = text.trim()
    if (!captured || !note || note.length > maxText || comments.length >= maxComments) return false
    const comment = { ...captured, id: crypto.randomUUID(), text: note }
    const saved = await changeDrafts(items => {
      if (items.length >= maxComments) throw new Error('Comment limit reached.')
      return [...items, comment]
    })
    if (saved) setCapture(previous => previous?.root === projectRoot && previous.value === captured ? undefined : previous)
    return saved
  }

  async function createSession(): Promise<void> {
    if (!projectRoot || sessionBusy || !iterationEnabled) return
    setSessionBusy(true)
    setError(undefined)
    try {
      const session = unwrap(await remote.createIterationSession(projectRoot))
      if (root.current !== projectRoot) return
      setRecent(previous => ({
        root: projectRoot,
        value: [session, ...(previous?.root === projectRoot ? previous.value.filter(entry => entry.id !== session.id) : [])],
      }))
      setSelected({ root: projectRoot, value: session.id })
    } catch (cause) {
      if (root.current === projectRoot) setError({ root: projectRoot, value: errorMessage(cause) })
    } finally {
      setSessionBusy(false)
    }
  }

  async function submit(retry: boolean, note: string): Promise<void> {
    if (!projectRoot || !iterationEnabled || active || sendInFlight.current) return
    const session = retry ? view?.sessionId : sessionId
    if (!session || (retry ? view?.phase !== 'failed' : !comments.length)) return
    const submitted = retry ? noComments : comments
    const commentIds = submitted.map(comment => comment.id)
    const retryOf = retry ? view?.batchId ?? null : null
    const repairNote = retry ? note.trim() : ''
    const previous = pendingBatch.current.get(projectRoot) ?? readPendingBatch(projectRoot)
    const matches = previous?.sessionId === session && previous.retryOf === retryOf &&
      previous.repairNote === repairNote && JSON.stringify(previous.commentIds) === JSON.stringify(commentIds)
    const batchId = matches ? previous.batchId : crypto.randomUUID()
    const pending = { batchId, sessionId: session, commentIds, retryOf, repairNote }
    pendingBatch.current.set(projectRoot, pending)
    writePendingBatch(projectRoot, pending)
    sendInFlight.current = true
    statusFence.current++
    setSending(true)
    setError(undefined)
    try {
      adopt(projectRoot, unwrap(await remote.submitIteration({
        projectRoot, sessionId: session, batchId, comments: submitted, retryOf, repairNote,
      })))
    } catch (cause) {
      if (root.current === projectRoot) setError({ root: projectRoot, value: errorMessage(cause) })
    } finally {
      sendInFlight.current = false
      setSending(false)
    }
  }

  return {
    comments, captured, sessions, sessionId, view, active, sending, draftBusy, sessionBusy,
    error: error?.root === projectRoot ? error.value : undefined,
    statusError: statusError?.root === projectRoot ? statusError.value : undefined,
    draftError: draftError?.root === projectRoot && draftError.value,
    draftsReady: drafts?.root === projectRoot,
    capture: (value: CapturedComment) => setCapture({ root: projectRoot, value }),
    discard: () => setCapture(undefined),
    saveComment,
    removeComment: (id: string) => changeDrafts(items => items.filter(comment => comment.id !== id)),
    selectSession: (id: string) => setSelected({ root: projectRoot, value: id }),
    createSession,
    submit,
  }
}

type IterationPanelProps = PropsLocale<typeof namespace> & {
  state: ReturnType<typeof useIteration>
  commentingEnabled: boolean
  iterationEnabled: boolean
  liveStatus?: 'waiting' | 'ready'
  canSubmit: boolean
  onOpenSession: (id: string) => void
}

function CommentFrame({ capture, label }: { capture: CapturedComment; label: string }) {
  const { selection, frame, frameWidth, frameHeight } = capture
  return (
    <div className="appstudio-comment-frame">
      <img src={frame} alt={label} />
      <span
        aria-hidden="true"
        className="appstudio-selection"
        data-kind={selection.kind}
        style={{
          left: `${selection.x / frameWidth * 100}%`,
          top: `${selection.y / frameHeight * 100}%`,
          width: selection.kind === 'area' ? `${selection.width / frameWidth * 100}%` : undefined,
          height: selection.kind === 'area' ? `${selection.height / frameHeight * 100}%` : undefined,
        }}
      />
    </div>
  )
}

export function IterationPanel({ state, commentingEnabled, iterationEnabled, liveStatus, canSubmit, onOpenSession, t }: IterationPanelProps) {
  const [text, setText] = useState('')
  const [repairNote, setRepairNote] = useState('')
  const { comments, captured, view } = state
  const busy = state.active || state.sending
  const maySubmit = canSubmit && !busy && !state.draftBusy
  const assigned = state.sessions.find(session => session.id === view?.sessionId)
  const detail = view?.phase === 'applied' ? t(
    liveStatus === 'ready' ? 'iterationLiveReady' : liveStatus === 'waiting' ? 'iterationLiveWaiting' : 'iterationAppliedSaved',
  ) : view?.detail

  return (
    <section className="appstudio-runtime" aria-label={t('iterations')} data-appstudio-iteration="">
      <div className="appstudio-runtime-title">
        <h2>{t('iterations')}</h2>
        {view && <span role="status" data-appstudio-iteration-phase={view.phase}>{t(`iteration.${view.phase}`)}</span>}
      </div>
      {commentingEnabled && captured && (
        <form className="appstudio-comment-composer" onSubmit={event => {
          event.preventDefault()
          void state.saveComment(text).then(saved => { if (saved) setText('') })
        }}>
          <CommentFrame capture={captured} label={t('commentFrame')} />
          <label>
            {t('commentText')}
            <textarea data-appstudio-comment-text="" value={text} maxLength={maxText} autoFocus onChange={event => setText(event.target.value)} />
          </label>
          <div className="appstudio-actions">
            <button type="submit" data-appstudio-save-comment="" disabled={!text.trim() || state.draftBusy || !state.draftsReady || comments.length >= maxComments}>
              {t('commentSave')}
            </button>
            <button type="button" onClick={() => { state.discard(); setText('') }}>{t('cancel')}</button>
          </div>
        </form>
      )}
      {state.draftError && <p role="alert">{t('commentStorageError')}</p>}
      {!!comments.length && (
        <ul className="appstudio-comment-list">
          {comments.map(comment => (
            <li key={comment.id} data-appstudio-comment="">
              <CommentFrame capture={comment} label={t('commentFrame')} />
              <div>
                <p>{comment.text}</p>
                <p>{t(comment.selection.kind === 'point' ? 'commentPoint' : 'commentArea')}</p>
              </div>
              {commentingEnabled && (
                <button type="button" disabled={state.draftBusy} onClick={() => void state.removeComment(comment.id)}>
                  {t('commentRemove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {commentingEnabled && comments.length >= maxComments && <p>{t('commentLimit')}</p>}
      {iterationEnabled && (
        <div className="appstudio-actions">
          <label>
            {t('iterationRecentSessions')}{' '}
            <select data-appstudio-iteration-session="" value={state.sessionId} onChange={event => state.selectSession(event.target.value)}>
              {!state.sessions.length && <option value="">{t('iterationNoSessions')}</option>}
              {state.sessions.map(session => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
            </select>
          </label>
          <button type="button" data-appstudio-new-iteration-session="" disabled={state.sessionBusy} onClick={() => void state.createSession()}>
            {t('iterationNewSession')}
          </button>
          <button type="button" disabled={!state.sessionId} onClick={() => onOpenSession(state.sessionId)}>{t('iterationOpenSession')}</button>
          <button type="button" data-appstudio-submit-iteration="" disabled={!maySubmit || !state.sessionId || !comments.length} onClick={() => void state.submit(false, '')}>
            {t('iterationSubmit')}
          </button>
        </div>
      )}
      {state.sending && <p role="status">{t('working')}</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.statusError && <p role="alert">{state.statusError}</p>}
      {view && (
        <>
          <p>{t('iterationAssignedSession')} {assigned?.title || view.sessionId}</p>
          {detail && <p data-appstudio-iteration-live={liveStatus}>{detail}</p>}
          {view.phase === 'failed' && iterationEnabled && (
            <form className="appstudio-comment-composer" onSubmit={event => {
              event.preventDefault()
              if (maySubmit) void state.submit(true, repairNote)
            }}>
              <label>
                {t('iterationRepairNote')}
                <textarea value={repairNote} maxLength={maxText} onChange={event => setRepairNote(event.target.value)} />
              </label>
              <div><button type="submit" data-appstudio-retry-iteration="" disabled={!maySubmit}>{t('iterationRetry')}</button></div>
            </form>
          )}
          {!!view.outcomes.length && (
            <ul className="appstudio-comment-outcomes">
              {view.outcomes.map(outcome => (
                <li key={outcome.commentId}>
                  <p><strong>{outcome.commentText}</strong></p>
                  <p>{t(outcome.status === 'reported' ? 'iterationReported' : 'iterationUnverified')} {outcome.detail}</p>
                </li>
              ))}
            </ul>
          )}
          {view.log && (
            <details>
              <summary>{t('iterationLogs')}</summary>
              <pre className="appstudio-project-output" data-appstudio-iteration-log="">{view.log}</pre>
            </details>
          )}
          {view.diff && (
            <details open>
              <summary>{t('iterationDiff')}</summary>
              <pre className="appstudio-project-output" data-appstudio-iteration-diff="">{view.diff}</pre>
            </details>
          )}
        </>
      )}
    </section>
  )
}
