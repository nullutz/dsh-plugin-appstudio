import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { DeviceRole, GenerationView, RuntimeView } from '../shared/protocol.ts'
import type { CapturedComment } from './annotations.ts'
import type { namespace } from './copy.ts'
import { GenerationPanel, useGeneration, type GenerationRemote } from './generation.tsx'
import { StudioIcon } from './icons.tsx'
import { IterationPanel, useIteration, type IterationRemote } from './iteration.tsx'
import { lastIterationProject } from './iteration-drafts.ts'
import type { OpenSignaling } from './peer.ts'
import { ProjectControls, useProjectRun, type ProjectRemote } from './project.tsx'
import { Viewport, type ReadyPreview } from './viewport.tsx'
import { stylesheet } from './styles.ts'

export interface StudioRemote extends ProjectRemote, IterationRemote, GenerationRemote {
  status(): Promise<RemoteResult<RuntimeView>>
  prepare(licenseAccepted: boolean): Promise<RemoteResult<RuntimeView>>
  start(): Promise<RemoteResult<RuntimeView>>
  stop(): Promise<RemoteResult<RuntimeView>>
  uninstall(): Promise<RemoteResult<RuntimeView>>
  reinitialize(licenseAccepted: boolean): Promise<RemoteResult<RuntimeView>>
  holdRuntime(signal?: AbortSignal): RemoteStreamHandle<boolean, never>
  signaling: OpenSignaling
}

type RuntimeAction = 'prepare' | 'start' | 'stop' | 'uninstall' | 'reinitialize'
type StudioProps = PropsLocale<typeof namespace> & { remote: StudioRemote }
type WorkbenchProps = StudioProps & {
  onOpenSession: (id: string) => void
  onPickDirectory: () => Promise<string | null>
  workspaceRoot: string
}
const licenseUrl = 'https://developer.android.com/studio/terms'

function unwrap(result: RemoteResult<RuntimeView>): RuntimeView {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

type LeasedViewportProps = StudioProps & {
  targetRole?: DeviceRole
  targetDeployment?: string
  managed: boolean
  onSelectedRole: (role: DeviceRole) => void
  onReady: (preview: ReadyPreview | undefined) => void
  commentingEnabled: boolean
  canAnnotate: boolean
  commentMode: boolean
  onToggleCommentMode: () => void
  onCapture: (capture: CapturedComment) => void
}

function LeasedViewport({ remote, t, ...viewport }: LeasedViewportProps) {
  const [opened, setOpened] = useState(false)
  const [leaseInterrupted, setLeaseInterrupted] = useState(false)
  const signaling = useCallback<OpenSignaling>((...args) => remote.signaling(...args), [remote])

  useEffect(() => {
    const controller = new AbortController()
    let lease: ReturnType<StudioRemote['holdRuntime']> | undefined
    let retry: number | undefined

    async function hold(): Promise<void> {
      try {
        lease = remote.holdRuntime(controller.signal)
        for await (const acquired of lease) {
          if (controller.signal.aborted) return
          if (acquired) {
            setOpened(true)
            setLeaseInterrupted(false)
          }
        }
      } catch {
        // A new DSH connection can acquire the lease during the Host's idle grace period.
      } finally {
        lease?.dispose()
        if (!controller.signal.aborted) {
          setLeaseInterrupted(true)
          retry = window.setTimeout(() => void hold(), 1_000)
        }
      }
    }

    void hold()
    return () => {
      controller.abort()
      window.clearTimeout(retry)
      lease?.dispose()
    }
  }, [remote])

  return (
    <>
      {opened && <Viewport signaling={signaling} t={t} {...viewport} />}
      {leaseInterrupted
        ? <p className="appstudio-device-status" role="status">{t('leaseInterrupted')}</p>
        : !opened && <p className="appstudio-device-status" role="status">{t('connecting')}</p>}
    </>
  )
}

export function Workbench({ remote, t, onOpenSession, onPickDirectory, workspaceRoot }: WorkbenchProps) {
  const [runtime, setRuntime] = useState<RuntimeView>()
  const [notice, setNotice] = useState('')
  const [statusNotice, setStatusNotice] = useState('')
  const [settings, setSettings] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [confirmation, setConfirmation] = useState<'uninstall' | 'reinitialize'>()
  const [working, setWorking] = useState<RuntimeAction>()
  const [viewportRole, setViewportRole] = useState<DeviceRole>()
  const [readyPreview, setReadyPreview] = useState<ReadyPreview>()
  const [lastProjectRoot, setLastProjectRoot] = useState(() => lastIterationProject())
  const [commentModeProject, setCommentModeProject] = useState('')
  const [tab, setTab] = useState<'live' | 'starter'>('live')
  const [created, setCreated] = useState<GenerationView>()
  const refreshedBatch = useRef('')
  const workspacePrefilled = useRef(false)
  const settingsSection = useRef<HTMLElement>(null)
  const generation = useRef(0)
  const refreshing = useRef(false)
  const action = useRef<RuntimeAction>()
  const settingsId = useId()

  const refresh = useCallback(async () => {
    if (refreshing.current) return
    const request = generation.current
    refreshing.current = true
    try {
      const value = unwrap(await remote.status())
      if (request === generation.current) {
        setRuntime(value)
        setStatusNotice('')
      }
    } catch (error) {
      if (request === generation.current) setStatusNotice(error instanceof Error ? error.message : String(error))
    } finally {
      refreshing.current = false
    }
  }, [remote])

  useEffect(() => {
    void refresh()
    const poll = window.setInterval(() => void refresh(), 4_000)
    return () => {
      window.clearInterval(poll)
      generation.current++
    }
  }, [refresh])

  async function run(command: RuntimeAction): Promise<void> {
    if (action.current) return
    const request = ++generation.current
    action.current = command
    setWorking(command)
    setNotice('')
    setConfirmation(undefined)
    try {
      const response = command === 'prepare' || command === 'reinitialize'
        ? await remote[command](accepted)
        : await remote[command]()
      const value = unwrap(response)
      if (request === generation.current) setRuntime(value)
    } catch (error) {
      if (request === generation.current) setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      action.current = undefined
      if (request === generation.current) {
        generation.current++
        setWorking(undefined)
        void refresh()
      }
    }
  }

  const phase = runtime?.phase
  const enabled = runtime?.androidEnabled === true && phase !== 'unsupported'
  const installed = phase === 'stopped' || phase === 'running' || phase === 'error'
  const configuring = phase === 'unconfigured' || phase === 'error'
  const pending = working || phase === 'starting' || phase === 'stopping' || phase === 'preparing'
  const closing = working === 'stop' || working === 'uninstall' || working === 'reinitialize'
  const project = useProjectRun(remote, enabled, phase === 'running')
  const activeProjectRoot = phase === 'running' && project.project?.framework ? project.project.projectRoot : ''
  const iterationRoot = activeProjectRoot || lastProjectRoot
  const commentingEnabled = runtime?.commentingEnabled === true
  const iterationEnabled = runtime?.iterationEnabled === true
  const layoutEnabled = runtime?.layoutEnabled === true
  const promptEnabled = runtime?.promptEnabled === true
  const starterAvailable = layoutEnabled || promptEnabled
  const starter = starterAvailable && tab === 'starter'
  const iteration = useIteration(remote, iterationRoot, commentingEnabled, iterationEnabled)
  const creation = useGeneration(remote, project.draft.projectRoot.trim(), starterAvailable, starter)
  const iterationBusy = iteration.sending || (iterationEnabled && iteration.active)
  const generationBusy = creation.active || creation.sending
  const runtimeControlsDisabled = !!pending || !!project.pending || iterationBusy || generationBusy
  const canPreview = enabled && !closing && phase === 'running' && runtime?.devices.length === 2 && !!project.project
  const targetRole = project.project?.framework ? project.project.activeRole : undefined
  const projectFramework = project.project?.framework
  const iterationFrameworkEnabled = !!projectFramework && runtime?.frameworks.includes(projectFramework) === true
  const appliedBatch = iteration.view?.phase === 'applied' ? iteration.view : undefined
  const refreshingApplied = !!appliedBatch && appliedBatch.projectRoot === activeProjectRoot &&
    (refreshedBatch.current !== appliedBatch.batchId || project.statusRefreshing || !!project.statusError)
  const handingOff = refreshingApplied || (canPreview && !!targetRole && !!viewportRole && viewportRole !== targetRole)
  const readyForProject = !!readyPreview && readyPreview.role === targetRole &&
    readyPreview.deploymentId === project.project?.deploymentId
  const appliedProject = appliedBatch?.project
  const appliedInLive = !!appliedProject && canPreview && appliedProject.projectRoot === activeProjectRoot &&
    (refreshingApplied || (appliedProject.activeRole === targetRole && appliedProject.deploymentId === project.project?.deploymentId))
  const iterationLive = appliedInLive ? (readyForProject && !refreshingApplied ? 'ready' : 'waiting') : undefined
  const commentMode = !!activeProjectRoot && commentingEnabled && !iterationBusy && commentModeProject === activeProjectRoot
  const framework = runtime?.frameworks.includes(project.draft.framework) ? project.draft.framework : runtime?.frameworks[0]
  const projectName = activeProjectRoot.split(/[\\/]/u).filter(Boolean).at(-1)
  const currentWorkspace = workspaceRoot.split(/[\\/]/u).filter(Boolean).at(-1)

  useEffect(() => {
    if (workspacePrefilled.current || !runtime || (phase === 'running' && !project.project)) return
    const suggested = creation.receipt?.projectRoot || workspaceRoot
    if (!suggested || !/^[a-z]:[\\/]/iu.test(suggested)) return
    workspacePrefilled.current = true
    project.setDraft(previous => previous.projectRoot ? previous : { ...previous, projectRoot: suggested })
  }, [creation.receipt?.projectRoot, phase, project.project, project.setDraft, runtime, workspaceRoot])

  useEffect(() => {
    if (settings) settingsSection.current?.scrollIntoView({ block: 'nearest' })
  }, [settings])

  useEffect(() => {
    const completed = creation.result
    const generated = completed?.project
    if (!completed || !generated?.framework) return
    setCreated(completed)
    project.setDraft({ projectRoot: generated.projectRoot, framework: generated.framework })
    creation.acknowledge(completed.batchId)
    setTab('live')
    project.refresh()
    void refresh()
  }, [creation.acknowledge, creation.result, project.refresh, project.setDraft, refresh])

  useEffect(() => {
    if (activeProjectRoot) setLastProjectRoot(lastIterationProject(activeProjectRoot))
  }, [activeProjectRoot])

  useEffect(() => {
    if (!commentingEnabled || !activeProjectRoot || iterationBusy) setCommentModeProject('')
  }, [commentingEnabled, activeProjectRoot, iterationBusy])

  useEffect(() => {
    if (!appliedBatch || refreshedBatch.current === appliedBatch.batchId) return
    refreshedBatch.current = appliedBatch.batchId
    project.refresh()
  }, [appliedBatch, project.refresh])

  useEffect(() => {
    if (!canPreview) {
      setViewportRole(undefined)
      setReadyPreview(undefined)
    }
  }, [canPreview])

  return (
    <main className="appstudio-workbench" data-appstudio-workbench="">
      <style>{stylesheet}</style>
      <div className="appstudio-shell">
        <header className="appstudio-header">
          <div className="appstudio-brand">
            <span className="appstudio-brand-icon"><StudioIcon name="phone" size={23} /></span>
            <div>
              <h1>{t('title')}</h1>
              <p>{t('workbenchDescription')}</p>
            </div>
          </div>
          <div className="appstudio-header-actions">
            {currentWorkspace && <span className="appstudio-workspace" title={workspaceRoot}>
              <StudioIcon name="folder" size={15} /><span>{currentWorkspace}</span>
            </span>}
            {enabled && installed && (
              <button type="button" aria-expanded={settings} aria-controls={settingsId} onClick={() => {
                setConfirmation(undefined)
                setSettings(value => !value)
              }}>
                <StudioIcon name="settings" size={17} />{t('settings')}
              </button>
            )}
          </div>
        </header>
        <nav className="appstudio-nav" aria-label={t('workbenchTabs')}>
          <button type="button" aria-pressed={!starter} data-appstudio-tab="live" onClick={() => setTab('live')}>
            <StudioIcon name="phone" size={16} />{t('workbenchLive')}
          </button>
          {starterAvailable && <button type="button" aria-pressed={starter} data-appstudio-tab="starter" onClick={() => setTab('starter')}>
            <StudioIcon name="plus" size={16} />{t('workbenchStarter')}{generationBusy && <span className="appstudio-active-dot" aria-label={t('working')} />}
          </button>}
        </nav>
        <div className="appstudio-grid">
          <div className="appstudio-main-column">
            <section className="appstudio-surface appstudio-stage" aria-label={t('workbenchLive')} hidden={starter}>
              <header className="appstudio-surface-header">
                <div>
                  <p className="appstudio-eyebrow">{t('subtitle')}</p>
                  <h2>{projectName || t('workbenchPreviewTitle')}</h2>
                  <p>{projectFramework ? t(projectFramework) + ' · ' + project.project?.applicationId : t('workbenchPreviewSummary')}</p>
                </div>
                <span className="appstudio-status" data-phase={phase ?? 'checking'}>
                  {phase ? t(phase) : t('checking')}
                </span>
              </header>
              {canPreview ? <LeasedViewport
                remote={remote}
                t={t}
                targetRole={targetRole}
                targetDeployment={project.project?.deploymentId}
                managed={!!targetRole || !!project.pending}
                onSelectedRole={setViewportRole}
                onReady={setReadyPreview}
                commentingEnabled={commentingEnabled}
                canAnnotate={!!activeProjectRoot && readyForProject && !handingOff && !iterationBusy &&
                  !iteration.captured && iteration.draftsReady}
                commentMode={commentMode}
                onToggleCommentMode={() => setCommentModeProject(commentMode ? '' : activeProjectRoot)}
                onCapture={iteration.capture}
              /> : <div className="appstudio-preview-empty">
                <div className="appstudio-empty-phone" aria-hidden="true">
                  <span /><div><StudioIcon name="phone" size={33} /></div><span />
                </div>
                <div className="appstudio-empty-copy">
                  <h3>{t('workbenchEmptyTitle')}</h3>
                  <p>{t('workbenchEmptyHelp')}</p>
                  {starterAvailable && <button type="button" onClick={() => setTab('starter')}>
                    {t('workbenchStarter')} <StudioIcon name="arrow" size={16} />
                  </button>}
                </div>
              </div>}
            </section>
            {starterAvailable && <div hidden={!starter}>
              <GenerationPanel state={creation} t={t} projectRoot={project.draft.projectRoot.trim()} framework={framework}
                layoutEnabled={layoutEnabled} promptEnabled={promptEnabled}
                disabled={!enabled || !installed || !!pending || !!project.pending || handingOff || iterationBusy} onOpenSession={onOpenSession} />
            </div>}
          </div>
          <aside className="appstudio-inspector" aria-label={t('workbenchInspector')}>
            <ProjectControls
              state={project}
              disabled={!!pending || handingOff || iterationBusy || generationBusy}
              runnable={enabled && installed}
              running={phase === 'running'}
              frameworks={runtime?.frameworks}
              starter={starter}
              workspaceRoot={workspaceRoot}
              onPickDirectory={onPickDirectory}
              t={t}
            />
            {!starter && created?.sessionId && created.project?.projectRoot === activeProjectRoot && (
              <section className="appstudio-runtime appstudio-created" aria-label={t('generation.applied')}>
                <div><StudioIcon name="check" size={17} /><strong>{t('generation.applied')}</strong></div>
                <button type="button" onClick={() => onOpenSession(created.sessionId!)}>{t('starterOpenSession')}
                  <StudioIcon name="external" size={14} />
                </button>
              </section>
            )}
            {iterationRoot && (commentingEnabled || iterationEnabled) && <div hidden={starter}>
              <IterationPanel
                key={iterationRoot}
                state={iteration}
                commentingEnabled={commentingEnabled}
                iterationEnabled={iterationEnabled}
                liveStatus={iterationLive}
                canSubmit={!!activeProjectRoot && canPreview && readyForProject && iterationFrameworkEnabled && !handingOff && !pending &&
                  !project.pending && !generationBusy}
                onOpenSession={onOpenSession}
                t={t}
              />
            </div>}
            <section className="appstudio-runtime appstudio-runtime-controls" aria-label={t('runtime')} aria-busy={!!pending} ref={settingsSection}>
              <div className="appstudio-runtime-title">
                <h2>{t('runtime')}</h2>
                <span className="appstudio-status" role="status" data-phase={phase ?? 'checking'}>{phase ? t(phase) : t('checking')}</span>
              </div>
              {runtime?.detail && <p>{runtime.detail}</p>}
              {runtime && !runtime.androidEnabled && <p>{t('androidDisabled')}</p>}
              {(notice || statusNotice) && <p role="alert">{notice || statusNotice}</p>}
              {enabled && (configuring || (settings && installed)) && (
                <div className="appstudio-license">
                  <label>
                    <input type="checkbox" checked={accepted} disabled={runtimeControlsDisabled} onChange={event => setAccepted(event.target.checked)} />
                    {t('acceptLicense')}
                  </label>
                  <a href={licenseUrl} target="_blank" rel="noreferrer">{t('licenseAgreement')}</a>
                </div>
              )}
              <div className="appstudio-actions">
                {enabled && configuring && (
                  <button type="button" className="appstudio-primary" disabled={!accepted || runtimeControlsDisabled}
                    onClick={() => void run('prepare')}>{t('prepare')}</button>
                )}
                {enabled && (phase === 'stopped' || phase === 'error') && (
                  <button type="button" className={configuring ? undefined : 'appstudio-primary'}
                    disabled={runtimeControlsDisabled} onClick={() => void run('start')}>{t('start')}</button>
                )}
                {enabled && (phase === 'running' || phase === 'error') && (
                  <button type="button" disabled={runtimeControlsDisabled} onClick={() => void run('stop')}>{t('stop')}</button>
                )}
                <button type="button" disabled={!!working} onClick={() => {
                  setNotice('')
                  void refresh()
                }}>{t('refresh')}</button>
                {working && <span role="status">{t('working')}</span>}
              </div>
              <div id={settingsId} hidden={!settings || !enabled || !installed}>
                <div className="appstudio-actions">
                  <button type="button" disabled={runtimeControlsDisabled} onClick={() => setConfirmation('uninstall')}>{t('uninstall')}</button>
                  <button type="button" disabled={!accepted || runtimeControlsDisabled} onClick={() => setConfirmation('reinitialize')}>{t('reinitialize')}</button>
                </div>
              </div>
              {enabled && installed && confirmation && (
                <div className="appstudio-confirmation" role="group">
                  <p>{t(confirmation === 'uninstall' ? 'confirmUninstall' : 'confirmReinitialize')}</p>
                  <div className="appstudio-actions">
                    <button type="button" onClick={() => setConfirmation(undefined)}>{t('cancel')}</button>
                    <button
                      type="button"
                      disabled={runtimeControlsDisabled || (confirmation === 'reinitialize' && !accepted)}
                      onClick={() => void run(confirmation)}
                    >
                      {t(confirmation)}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </main>
  )
}
