import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { FrameworkId, ProjectRunConfig, ProjectRunEvent, ProjectView } from '../shared/protocol.ts'
import type { namespace } from './copy.ts'
import { StudioIcon } from './icons.tsx'

type RunAction = 'run' | 'rebuild'
type ProjectStream = RemoteStreamHandle<ProjectRunEvent, never>

export interface ProjectRemote {
  projectStatus(): Promise<RemoteResult<ProjectView>>
  runProject(config: ProjectRunConfig, signal?: AbortSignal): ProjectStream
  rebuildProject(config: ProjectRunConfig, signal?: AbortSignal): ProjectStream
}

const maxOutput = 48_000
const emptyDraft: ProjectRunConfig = { projectRoot: '', framework: 'flutter' }

export function useProjectRun(remote: ProjectRemote, enabled: boolean, runtimeRunning: boolean) {
  const [draft, setDraft] = useState<ProjectRunConfig>(emptyDraft)
  const [project, setProject] = useState<ProjectView>()
  const [pending, setPending] = useState<RunAction>()
  const [progress, setProgress] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [statusRefreshing, setStatusRefreshing] = useState(false)
  const [interrupted, setInterrupted] = useState(false)
  const [canceled, setCanceled] = useState(false)
  const [statusAttempt, setStatusAttempt] = useState(0)
  const operation = useRef<AbortController | null>(null)

  useEffect(() => () => {
    operation.current?.abort()
    operation.current = null
  }, [remote])

  useEffect(() => {
    if (!enabled) {
      operation.current?.abort()
      setProject(undefined)
      setStatusError('')
      setStatusRefreshing(false)
      return
    }
    if (pending) return
    let closed = false
    async function read(): Promise<void> {
      try {
        const result = await remote.projectStatus()
        if (closed || operation.current) return
        if (!result.ok) throw new Error(result.error.message)
        const view = result.value
        setProject(view)
        setStatusError('')
        const framework = view.framework
        if (framework && view.projectRoot) {
          setDraft(previous => previous.projectRoot ? previous : { projectRoot: view.projectRoot, framework })
        }
      } catch (cause) {
        if (!closed && !operation.current) setStatusError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!closed && !operation.current) setStatusRefreshing(false)
      }
    }
    void read()
    return () => { closed = true }
  }, [remote, enabled, runtimeRunning, pending, statusAttempt])

  const refresh = useCallback(() => {
    setStatusRefreshing(true)
    setStatusAttempt(value => value + 1)
  }, [])

  async function run(action: RunAction, config: ProjectRunConfig): Promise<void> {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    let stream: ProjectStream | undefined
    let finished = false
    setPending(action)
    setProgress('')
    setOutput('')
    setError('')
    setInterrupted(false)
    setCanceled(false)

    try {
      stream = action === 'run'
        ? remote.runProject(config, controller.signal)
        : remote.rebuildProject(config, controller.signal)
      for await (const event of stream) {
        if (controller.signal.aborted) break
        if (event.kind === 'progress') setProgress(event.text)
        else if (event.kind === 'log') setOutput(previous => (previous + event.text + '\n').slice(-maxOutput))
        else if (event.kind === 'error') {
          setError(event.text)
          finished = true
        } else if (event.kind === 'ready') {
          setProject(event.project)
          const framework = event.project.framework
          if (action === 'run' && framework) {
            setDraft({ projectRoot: event.project.projectRoot, framework })
          }
          finished = true
        }
      }
      if (!controller.signal.aborted && !finished) setInterrupted(true)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      stream?.dispose()
      if (operation.current === controller) {
        operation.current = null
        setPending(undefined)
        if (controller.signal.aborted && !finished) setCanceled(true)
      }
    }
  }

  return {
    draft, setDraft, project, pending, progress, output, error, statusError, statusRefreshing, interrupted, canceled, run,
    cancel: () => operation.current?.abort(),
    refresh,
  }
}

type ProjectControlsProps = PropsLocale<typeof namespace> & {
  state: ReturnType<typeof useProjectRun>
  disabled: boolean
  runnable: boolean
  running: boolean
  frameworks?: readonly FrameworkId[]
  starter: boolean
  workspaceRoot: string
  onPickDirectory: () => Promise<string | null>
}

export function ProjectControls({
  state, disabled, runnable, running, frameworks, starter, workspaceRoot, onPickDirectory, t,
}: ProjectControlsProps) {
  const id = useId()
  const [directoryBusy, setDirectoryBusy] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const { draft, setDraft, project, pending } = state
  const projectRoot = draft.projectRoot.trim()
  const runningFramework = running ? project?.framework : undefined
  const selectedFramework = frameworks?.includes(draft.framework) ? draft.framework : frameworks?.[0]
  const controlsDisabled = disabled || !!pending
  const canRun = runnable && !!selectedFramework && /^[a-z]:[\\/]/iu.test(projectRoot) &&
    (projectRoot !== project?.projectRoot || selectedFramework !== runningFramework)
  const canRebuild = !!runningFramework && frameworks?.includes(runningFramework) === true
  const inProgress = pending === 'run' ? t('projectRunning') : t('projectRebuilding')
  const runError = state.error || (state.interrupted ? t('projectInterrupted') : '')

  useEffect(() => {
    if (!selectedFramework || selectedFramework === draft.framework) return
    setDraft(previous => frameworks?.includes(previous.framework)
      ? previous
      : { ...previous, framework: selectedFramework })
  }, [draft.framework, frameworks, selectedFramework, setDraft])

  async function browse(): Promise<void> {
    setDirectoryBusy(true)
    setDirectoryError('')
    try {
      const selected = await onPickDirectory()
      if (selected) setDraft(previous => ({ ...previous, projectRoot: selected }))
    } catch (cause) {
      setDirectoryError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDirectoryBusy(false)
    }
  }

  return (
    <section className="appstudio-runtime" aria-label={t('project')} data-appstudio-project="">
      <div className="appstudio-runtime-title">
        <h2>{t(starter ? 'starterTarget' : 'project')}</h2>
        {pending && <span role="status" data-appstudio-project-state={pending}>{state.progress || inProgress}</span>}
      </div>
      {starter && <p>{t('starterEmptyFolderHelp')}</p>}
      {frameworks?.length === 0 && <p role="status">{t('projectNoFrameworks')}</p>}
      <form onSubmit={event => {
        event.preventDefault()
        if (!starter && selectedFramework && canRun && !controlsDisabled) {
          void state.run('run', { projectRoot, framework: selectedFramework })
        }
      }}>
        <fieldset className="appstudio-project-fields" disabled={controlsDisabled}>
          <label htmlFor={id + '-root'}>{t('projectRoot')}</label>
          <div className="appstudio-directory-field">
            <input
              id={id + '-root'}
              data-appstudio-project-root=""
              value={draft.projectRoot}
              placeholder={'C:\\Projects\\my-app'}
              onChange={event => setDraft({ ...draft, projectRoot: event.target.value })}
              spellCheck={false}
              required
            />
            <button type="button" className="appstudio-icon-button" disabled={directoryBusy}
              title={t('pickFolder')} aria-label={t('pickFolder')} data-appstudio-pick-directory="" onClick={() => void browse()}>
              <StudioIcon name="folder" size={17} />
            </button>
          </div>
          {workspaceRoot && workspaceRoot !== projectRoot && (
            <div className="appstudio-actions">
              <button type="button" onClick={() => setDraft(previous => ({ ...previous, projectRoot: workspaceRoot }))}>
                {t('useWorkspaceFolder')}
              </button>
            </div>
          )}
          {directoryError && <p role="alert">{directoryError}</p>}
          <label htmlFor={id + '-framework'}>{t('projectFramework')}</label>
          <select
            id={id + '-framework'}
            data-appstudio-project-framework=""
            value={selectedFramework ?? ''}
            disabled={!selectedFramework}
            onChange={event => {
              const framework = frameworks?.find(option => option === event.target.value)
              if (framework) setDraft({ ...draft, framework })
            }}
          >
            {frameworks?.map(framework => <option key={framework} value={framework}>{t(framework)}</option>)}
          </select>
          {!starter && <div className="appstudio-actions">
            <button type="submit" className="appstudio-primary" data-appstudio-project-run=""
              disabled={!canRun || controlsDisabled}>{t('projectRun')}</button>
            {runningFramework && project && (
              <button type="button" data-appstudio-project-rebuild="" disabled={!runnable || controlsDisabled || !canRebuild} onClick={() =>
                void state.run('rebuild', { projectRoot: project.projectRoot, framework: runningFramework })
              }>
                {t('projectRebuild')}
              </button>
            )}
          </div>}
        </fieldset>
      </form>
      {pending && <div><button type="button" onClick={state.cancel}>{t('projectCancel')}</button></div>}
      {runningFramework && project && (
        <p className="appstudio-project-current" data-appstudio-project-current="">
          {t('projectCurrent')} {project.projectRoot} · {project.applicationId} · {project.versionCode}
          {project.restored && <> · {t('projectSceneRestored')}</>}
          {!!frameworks?.length && !canRebuild && <> · {t('projectCurrentFrameworkDisabled')}</>}
        </p>
      )}
      {state.canceled && <p role="status">{t('projectCanceled')}</p>}
      {runError && <p role="alert">{runError}</p>}
      {state.statusError && (
        <div className="appstudio-actions">
          <p role="alert">{state.statusError}</p>
          <button type="button" onClick={state.refresh}>{t('refresh')}</button>
        </div>
      )}
      {state.output && <details open={!!pending || !!runError}>
        <summary>{t('projectLogs')}</summary>
        <pre className="appstudio-project-output" data-appstudio-project-output="">{state.output}</pre>
      </details>}
      {!starter && <details className="appstudio-project-help">
        <summary>{t('projectSceneTitle')}</summary>
        <p>{t('projectSceneHelp')}</p>
      </details>}
    </section>
  )
}
