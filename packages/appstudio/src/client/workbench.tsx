import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { GenerationView, RuntimeView } from '../shared/protocol.ts'
import type { namespace } from './copy.ts'
import { GenerationPanel, useGeneration, type GenerationRemote } from './generation.tsx'
import { StudioIcon } from './icons.tsx'
import { IterationPanel, useIteration, type IterationRemote } from './iteration.tsx'
import { lastIterationProject } from './iteration-drafts.ts'
import type { OpenSignaling } from './peer.ts'
import { PreviewSession } from './preview.ts'
import { ProjectControls, useProjectRun, type ProjectRemote } from './project.tsx'
import { Viewport } from './viewport.tsx'
import { stylesheet } from './styles.ts'

export interface StudioRemote extends ProjectRemote, IterationRemote, GenerationRemote {
  status(): Promise<RemoteResult<RuntimeView>>
  prepare(licenseAccepted: boolean): Promise<RemoteResult<RuntimeView>>
  start(): Promise<RemoteResult<RuntimeView>>
  startPreview(): Promise<RemoteResult<RuntimeView>>
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
  runtimeLease: ReturnType<typeof createRuntimeLease>
}
const licenseUrl = 'https://developer.android.com/studio/terms'

function projectPathKey(path: string): string {
  return path.replaceAll('/', '\\').replace(/\\+$/u, '').toLowerCase()
}

function unwrap(result: RemoteResult<RuntimeView>): RuntimeView {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export function createRuntimeLease(remote: Pick<StudioRemote, 'holdRuntime' | 'signaling'>) {
  type Lease = { controller: AbortController; stream?: ReturnType<StudioRemote['holdRuntime']>; retry?: number }
  const closed = { opened: false, interrupted: false }
  const listeners = new Set<() => void>()
  let snapshot = closed
  let current: Lease | undefined
  const preview = new PreviewSession((...args) => remote.signaling(...args))

  function update(opened: boolean, interrupted: boolean): void {
    if (snapshot.opened === opened && snapshot.interrupted === interrupted) return
    snapshot = { opened, interrupted }
    for (const listener of listeners) listener()
  }

  async function hold(lease: Lease): Promise<void> {
    try {
      lease.stream = remote.holdRuntime(lease.controller.signal)
      for await (const acquired of lease.stream) {
        if (current !== lease) return
        if (acquired) update(true, false)
      }
    } catch {
      // A new DSH connection can acquire the lease during the Host's idle grace period.
    } finally {
      lease.stream?.dispose()
      lease.stream = undefined
      if (current === lease) {
        preview.reset()
        update(snapshot.opened, true)
        lease.retry = window.setTimeout(() => void hold(lease), 1_000)
      }
    }
  }

  return {
    preview,
    start() {
      if (current) return
      current = { controller: new AbortController() }
      void hold(current)
    },
    stop() {
      preview.reset()
      const lease = current
      if (!lease) return
      current = undefined
      window.clearTimeout(lease.retry)
      lease.controller.abort()
      lease.stream?.dispose()
      lease.stream = undefined
      update(false, false)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
  }
}

export function Workbench({ remote, t, onOpenSession, onPickDirectory, workspaceRoot, runtimeLease }: WorkbenchProps) {
  const [runtime, setRuntime] = useState<RuntimeView>()
  const [notice, setNotice] = useState('')
  const [statusNotice, setStatusNotice] = useState('')
  const [settings, setSettings] = useState(false)
  const [runtimeExpanded, setRuntimeExpanded] = useState<boolean>()
  const [accepted, setAccepted] = useState(false)
  const [confirmation, setConfirmation] = useState<'uninstall' | 'reinitialize'>()
  const [working, setWorking] = useState<RuntimeAction>()
  const [lastProjectRoot, setLastProjectRoot] = useState(() => lastIterationProject())
  const [commentModeProject, setCommentModeProject] = useState('')
  const [tab, setTab] = useState<'live' | 'starter'>('live')
  const [created, setCreated] = useState<GenerationView>()
  const refreshedBatch = useRef('')
  const refreshedGeneration = useRef('')
  const workspacePrefilled = useRef(false)
  const workbench = useRef<HTMLElement>(null)
  const settingsSection = useRef<HTMLElement>(null)
  const generation = useRef(0)
  const refreshing = useRef(false)
  const action = useRef<RuntimeAction>()
  const runtimeId = useId()
  const projectControlsId = useId()

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
    return () => { generation.current++ }
  }, [refresh])

  const backgroundStarting = runtime?.background === 'starting'
  useEffect(() => {
    const poll = window.setInterval(() => void refresh(), backgroundStarting ? 750 : 4_000)
    return () => window.clearInterval(poll)
  }, [backgroundStarting, refresh])

  async function run(command: RuntimeAction): Promise<void> {
    if (action.current) return
    const request = ++generation.current
    action.current = command
    setWorking(command)
    setNotice('')
    setConfirmation(undefined)
    const releasesRuntime = command === 'stop' || command === 'uninstall' || command === 'reinitialize'
    if (releasesRuntime) runtimeLease.stop()
    try {
      const response = command === 'prepare' || command === 'reinitialize'
        ? await remote[command](accepted)
        : command === 'start' && runtime?.supportsForegroundStart
          ? await remote.startPreview()
          : await remote[command]()
      const value = unwrap(response)
      if (request === generation.current) setRuntime(value)
    } catch (error) {
      if (request === generation.current) {
        setNotice(error instanceof Error ? error.message : String(error))
        if (releasesRuntime && runtime?.phase === 'running') runtimeLease.start()
      }
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
  const installed = runtime?.configured ?? (phase === 'stopped' || phase === 'running' || phase === 'error')
  const configuring = runtime?.configured === undefined ? phase === 'unconfigured' || phase === 'error'
    : !installed && (phase === 'unconfigured' || phase === 'error' || phase === 'stopped')
  const runtimeIssue = runtime?.issue
  const hostBlocked = runtimeIssue === 'wsl-unavailable' || runtimeIssue === 'wsl-kernel' || runtimeIssue === 'wsl-virtualization'
  const needsRepair = runtimeIssue === 'runtime-missing' || runtimeIssue === 'runtime-version' || runtimeIssue === 'runtime-ownership'
  const repairAvailable = installed && phase === 'error' &&
    (runtimeIssue === 'sdk-invalid' || runtimeIssue === 'gateway-dependencies')
  const maintenanceAvailable = installed || phase === 'error' && !hostBlocked
  const pending = working || phase === 'starting' || phase === 'stopping' || phase === 'preparing'
  const closing = working === 'stop' || working === 'uninstall' || working === 'reinitialize'
  const project = useProjectRun(remote, enabled, phase === 'running', workspaceRoot || lastProjectRoot, runtime?.resumeExpected === true)
  const activeProjectRoot = phase === 'running' && project.project?.framework ? project.project.projectRoot : ''
  const iterationRoot = activeProjectRoot || lastProjectRoot
  const commentingEnabled = runtime?.commentingEnabled === true
  const iterationEnabled = runtime?.iterationEnabled === true
  const layoutEnabled = runtime?.layoutEnabled === true
  const promptEnabled = runtime?.promptEnabled === true
  const starterAvailable = layoutEnabled || promptEnabled
  const starter = starterAvailable && tab === 'starter'
  const iteration = useIteration(remote, iterationRoot, commentingEnabled, iterationEnabled)
  const draftRoot = project.draft.projectRoot.trim()
  const creation = useGeneration(remote, draftRoot, starterAvailable, starter)
  const iterationBusy = iteration.sending || (iterationEnabled && iteration.active)
  const generationBusy = creation.active || creation.sending
  const generationPhase = creation.sending ? 'queued' : creation.view?.phase
  const generationRoot = creation.sending ? creation.receipt?.projectRoot : creation.view?.projectRoot
  const pendingHandoff = generationPhase === 'applied' && (creation.result || project.statusRefreshing)
  const previewGeneration = !activeProjectRoot && !project.pending && generationRoot &&
    projectPathKey(generationRoot) === projectPathKey(draftRoot) && (generationPhase !== 'applied' || pendingHandoff)
    ? generationPhase : undefined
  const runtimeControlsDisabled = !!pending || !!project.pending || iterationBusy || generationBusy
  const runtimeReady = enabled && !closing && phase === 'running' && runtime.devices.length > 0
  const backgroundReady = runtime?.devices.length === 2
  const { opened, interrupted: leaseInterrupted } = useSyncExternalStore(runtimeLease.subscribe, runtimeLease.getSnapshot)
  const preview = useSyncExternalStore(runtimeLease.preview.subscribe, runtimeLease.preview.getSnapshot)
  const canPreview = runtimeReady && !previewGeneration && project.runtimeResolved
  const targetRole = project.project?.framework ? project.project.activeRole : undefined
  const projectFramework = project.project?.framework
  const iterationFrameworkEnabled = !!projectFramework && runtime?.frameworks.includes(projectFramework) === true
  const appliedBatch = iteration.view?.phase === 'applied' ? iteration.view : undefined
  const appliedProject = appliedBatch?.project
  const appliedIsCurrent = !!appliedProject?.deploymentId && appliedProject.projectRoot === activeProjectRoot &&
    appliedProject.deploymentId === project.project?.deploymentId
  const refreshingApplied = !!appliedBatch && appliedBatch.projectRoot === activeProjectRoot &&
    ((!appliedIsCurrent && refreshedBatch.current !== appliedBatch.batchId) || project.statusRefreshing)
  const readyDeployment = preview.readyDeployment
  const readyForProject = !!readyDeployment && readyDeployment.projectRoot === activeProjectRoot && readyDeployment.role === targetRole &&
    readyDeployment.deploymentId === project.project?.deploymentId
  const handingOff = refreshingApplied || (canPreview && preview.handingOff)
  const viewingProject = preview.selectedRole === targetRole
  const viewingPublishedProject = !!readyDeployment && readyDeployment.projectRoot === activeProjectRoot &&
    preview.selectedRole === readyDeployment.role
  const appliedInLive = !!appliedProject && canPreview && appliedProject.projectRoot === activeProjectRoot &&
    (refreshingApplied || appliedIsCurrent)
  const iterationLive = appliedInLive ? (readyForProject && !refreshingApplied ? 'ready' : 'waiting') : undefined
  const commentMode = !!activeProjectRoot && commentingEnabled && viewingPublishedProject && commentModeProject === activeProjectRoot
  const framework = runtime?.frameworks.includes(project.draft.framework) ? project.draft.framework : runtime?.frameworks[0]
  const projectName = activeProjectRoot.split(/[\\/]/u).filter(Boolean).at(-1)
  const currentWorkspace = workspaceRoot.split(/[\\/]/u).filter(Boolean).at(-1)
  const projectContextRoot = starter ? draftRoot : activeProjectRoot || draftRoot
  const contextRoot = projectContextRoot || workspaceRoot
  const contextName = contextRoot.split(/[\\/]/u).filter(Boolean).at(-1)
  const separateWorkspace = !!currentWorkspace && !!projectContextRoot && projectPathKey(workspaceRoot) !== projectPathKey(projectContextRoot)
  const contextLabel = separateWorkspace ? currentWorkspace : workspaceRoot ? t('workbenchWorkspace') : t('project')
  const showRuntime = settings || (runtimeExpanded ?? (phase !== 'running' || runtime?.background === 'failed' || !!notice || !!statusNotice))

  useEffect(() => {
    if (runtimeReady) runtimeLease.start()
    else if (closing || phase === 'stopping' || phase === 'stopped' || phase === 'error' ||
        phase === 'unconfigured' || phase === 'unsupported') runtimeLease.stop()
  }, [closing, phase, runtimeLease, runtimeReady])

  useEffect(() => {
    if (workspacePrefilled.current || !runtime || (phase === 'running' && !project.project)) return
    const suggested = creation.receipt?.projectRoot || workspaceRoot
    if (!suggested || !/^[a-z]:[\\/]/iu.test(suggested)) return
    workspacePrefilled.current = true
    project.setDraft(previous => previous.projectRoot ? previous : { ...previous, projectRoot: suggested })
  }, [creation.receipt?.projectRoot, phase, project.project, project.setDraft, runtime, workspaceRoot])

  useEffect(() => {
    workbench.current?.scrollTo(0, 0)
  }, [starter])

  useEffect(() => {
    const scrollOptions = { block: 'nearest', container: 'nearest' } as const
    if (settings) settingsSection.current?.scrollIntoView(scrollOptions)
  }, [settings, starter])

  useEffect(() => {
    const completed = creation.result
    const observed = creation.view
    const applied = completed ?? (observed?.phase === 'applied' &&
      projectPathKey(observed.projectRoot) === projectPathKey(draftRoot) ? observed : undefined)
    const generated = applied?.project
    if (!applied || !generated?.framework) return
    if (completed) {
      project.setDraft({ projectRoot: generated.projectRoot, framework: generated.framework })
      creation.acknowledge(completed.batchId)
      setTab('live')
    }
    if (refreshedGeneration.current !== applied.batchId) {
      refreshedGeneration.current = applied.batchId
      setCreated(applied)
      project.refresh()
      void refresh()
    }
  }, [creation.acknowledge, creation.result, creation.view, draftRoot, project.refresh, project.setDraft, refresh])

  useEffect(() => {
    if (activeProjectRoot) setLastProjectRoot(lastIterationProject(activeProjectRoot))
  }, [activeProjectRoot])

  useEffect(() => {
    if (!commentingEnabled || !activeProjectRoot || iteration.sending) setCommentModeProject('')
  }, [commentingEnabled, activeProjectRoot, iteration.sending])

  useEffect(() => {
    if (!appliedBatch || appliedIsCurrent) return
    if (appliedProject?.framework && appliedProject.deploymentId && appliedProject.projectRoot === activeProjectRoot &&
        appliedBatch.sourceDeploymentId && appliedBatch.sourceDeploymentId === project.project?.deploymentId) {
      project.acceptDeployment(appliedProject)
    } else if (refreshedBatch.current !== appliedBatch.batchId) {
      refreshedBatch.current = appliedBatch.batchId
      project.refresh()
    }
  }, [activeProjectRoot, appliedBatch, appliedIsCurrent, appliedProject, project.acceptDeployment, project.project?.deploymentId, project.refresh])

  useEffect(() => {
    if (!canPreview || !opened || leaseInterrupted || !runtime) return
    runtimeLease.preview.configure(runtime.devices.map(device => device.id),
      targetRole ? { role: targetRole, projectRoot: activeProjectRoot, deploymentId: project.project?.deploymentId } : undefined,
      runtime.background === 'starting' && runtime.devices.length === 1 ? runtime.devices[0]?.id : undefined)
  }, [activeProjectRoot, canPreview, leaseInterrupted, opened, project.project?.deploymentId, runtime, runtimeLease, targetRole])

  return (
    <main ref={workbench} className="appstudio-workbench" data-appstudio-workbench="">
      <style>{stylesheet}</style>
      <div className="appstudio-shell">
        <header className="appstudio-header">
          <div className="appstudio-brand">
            <span className="appstudio-brand-icon"><StudioIcon name="studio" size={24} /></span>
            <h1>{t('title')}</h1>
          </div>
          <nav className="appstudio-nav" aria-label={t('workbenchTabs')}>
            <button type="button" aria-pressed={!starter} data-appstudio-tab="live" onClick={() => setTab('live')}>
              <StudioIcon name="live" size={19} />{t('workbenchLive')}
            </button>
            {starterAvailable && <button type="button" aria-pressed={starter} data-appstudio-tab="starter" onClick={() => setTab('starter')}>
              <StudioIcon name="plus" size={19} />{t('workbenchStarter')}{generationBusy && <span className="appstudio-active-dot" aria-label={t('working')} />}
            </button>}
          </nav>
          <div className="appstudio-header-actions">
            {contextName && <span className="appstudio-workspace" title={separateWorkspace ? contextRoot + '\n' + workspaceRoot : contextRoot}>
              <StudioIcon name="folder" size={18} />
              <span className="appstudio-workspace-text"><small>{contextLabel}</small><strong>{contextName}</strong></span>
            </span>}
            {enabled && (
              <button type="button" className="appstudio-icon-button appstudio-settings-button" aria-label={t('settings')}
                title={t('settings')} aria-expanded={settings} aria-controls={runtimeId} onClick={() => {
                setConfirmation(undefined)
                setSettings(value => !value)
              }}>
                <StudioIcon name="settings" size={21} />
              </button>
            )}
          </div>
        </header>
        <div className="appstudio-grid" data-view={starter ? 'starter' : 'live'}>
          <div className="appstudio-main-column">
            <section className="appstudio-stage" aria-label={t('workbenchLive')} hidden={starter}>
              {canPreview ? <>
                {opened && !leaseInterrupted && <Viewport
                  heading={<div className="appstudio-device-heading">
                    <h2 title={activeProjectRoot || undefined}>{projectName || t('workbenchPreviewTitle')}</h2>
                    {projectFramework && <p>{t(projectFramework)} · Android</p>}
                  </div>}
                  preview={runtimeLease.preview}
                  availableDevices={runtime?.devices ?? []}
                  backgroundFailed={runtime?.background === 'failed'}
                  t={t}
                  managed={!!targetRole || !!project.pending}
                  commentingEnabled={commentingEnabled}
                  canAnnotate={!!activeProjectRoot && viewingPublishedProject &&
                    !iteration.captured && iteration.draftsReady}
                  commentMode={commentMode}
                  onToggleCommentMode={() => setCommentModeProject(commentMode ? '' : activeProjectRoot)}
                  onCapture={iteration.capture}
                />}
                {(leaseInterrupted || !opened) && <p className="appstudio-device-status" role="status">
                  {t(leaseInterrupted ? 'leaseInterrupted' : 'connecting')}
                </p>}
              </> : <div className="appstudio-preview-empty">
                <div className="appstudio-empty-phone" aria-hidden="true">
                  <span /><div><StudioIcon name="phone" size={33} /></div><span />
                </div>
                <div className="appstudio-empty-copy" data-appstudio-live-generation={previewGeneration}>
                  {previewGeneration ? <div role="status">
                    <h3>{t(`generation.${previewGeneration}`)}</h3>
                    {previewGeneration === 'editing' ? <p>{t('starterEditingHelp')}</p> :
                      previewGeneration === 'applied' ? <p>{t('starterPreviewConnecting')}</p> :
                        !creation.sending && creation.view?.detail && <p>{creation.view.detail}</p>}
                  </div> : runtimeReady && runtime?.resumeExpected && !project.runtimeResolved ? (
                    <h3 role="status">{t('projectResuming')}</h3>
                  ) : <>
                    <h3>{t('workbenchEmptyTitle')}</h3>
                    <p>{t('workbenchEmptyHelp')}</p>
                  </>}
                  {starterAvailable && <button type="button" data-appstudio-live-generation-open={previewGeneration}
                    onClick={() => setTab('starter')}>
                    {t(previewGeneration === 'failed' ? 'starterViewFailure' : previewGeneration ? 'starterViewProgress' : 'workbenchStarter')}
                    <StudioIcon name="arrow" size={16} />
                  </button>}
                </div>
              </div>}
              {canPreview && commentingEnabled && !activeProjectRoot && (
                <p className="appstudio-device-status">{t('commentRunProject')}</p>
              )}
            </section>
            {starterAvailable && <div className="appstudio-creation-view" hidden={!starter}>
              <GenerationPanel state={creation} t={t} projectRoot={project.draft.projectRoot.trim()} framework={framework}
                projectControlsId={projectControlsId}
                layoutEnabled={layoutEnabled} promptEnabled={promptEnabled}
                disabled={!enabled || !installed || hostBlocked || needsRepair || !!pending || !!project.pending || handingOff || iterationBusy}
                onOpenSession={onOpenSession} />
            </div>}
          </div>
          <aside className="appstudio-inspector" aria-label={t('workbenchInspector')}>
            <div id={projectControlsId}>
              <ProjectControls
                state={project}
                disabled={!!pending || handingOff || iterationBusy || generationBusy}
                runnable={enabled && installed && !hostBlocked && !needsRepair}
                running={phase === 'running'}
                frameworks={runtime?.frameworks}
                starter={starter}
                workspaceRoot={workspaceRoot}
                onPickDirectory={onPickDirectory}
                t={t}
              />
            </div>
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
                canSubmit={!!activeProjectRoot && canPreview && backgroundReady && readyForProject && viewingProject && iterationFrameworkEnabled && !handingOff && !pending &&
                  !project.pending && !generationBusy}
                onOpenSession={onOpenSession}
                t={t}
              />
            </div>}
            <section className="appstudio-runtime appstudio-runtime-controls" aria-label={t('runtime')} aria-busy={!!pending} ref={settingsSection}>
              <button type="button" className="appstudio-runtime-toggle" aria-expanded={showRuntime} aria-controls={runtimeId}
                onClick={() => {
                  if (showRuntime) {
                    setSettings(false)
                    setConfirmation(undefined)
                  }
                  setRuntimeExpanded(!showRuntime)
                }}>
                <StudioIcon name="down" size={16} />
                <strong>{t('runtime')}</strong>
                <span className="appstudio-status" role="status" data-phase={phase ?? 'checking'}>{phase ? t(phase) : t('checking')}</span>
              </button>
              {!showRuntime && (notice || statusNotice) && <p role="alert">{notice || statusNotice}</p>}
              <div id={runtimeId} className="appstudio-runtime-body" hidden={!showRuntime}>
                {runtimeIssue ? <>
                  <p role="alert">{t(`runtimeIssue.${runtimeIssue}`)}</p>
                  {runtime?.detail && <details>
                    <summary>{t('runtimeDiagnostics')}</summary>
                    <pre className="appstudio-project-output">{runtimeIssue + '\n' + runtime.detail}</pre>
                  </details>}
                </> : runtime?.detail && <p>{runtime.detail}</p>}
                {runtime && !runtime.androidEnabled && <p>{t('androidDisabled')}</p>}
                {(notice || statusNotice) && <p role="alert">{notice || statusNotice}</p>}
                {enabled && ((configuring && !needsRepair) || repairAvailable || (settings && maintenanceAvailable && !hostBlocked)) && (
                  <div className="appstudio-license">
                    <label>
                      <input type="checkbox" checked={accepted} disabled={runtimeControlsDisabled} onChange={event => setAccepted(event.target.checked)} />
                      {t('acceptLicense')}
                    </label>
                    <a href={licenseUrl} target="_blank" rel="noreferrer">{t('licenseAgreement')}</a>
                  </div>
                )}
                <div className="appstudio-actions">
                  {enabled && ((configuring && !needsRepair) || repairAvailable) && (
                    <button type="button" className="appstudio-primary" disabled={!accepted || runtimeControlsDisabled}
                      onClick={() => void run('prepare')}>{t(repairAvailable ? 'repairRuntime' : 'prepare')}</button>
                  )}
                  {enabled && installed && !needsRepair && (phase === 'stopped' || phase === 'error') && (
                    <button type="button" className={configuring ? undefined : 'appstudio-primary'}
                      disabled={runtimeControlsDisabled} onClick={() => void run('start')}>{t('start')}</button>
                  )}
                  {enabled && installed && !hostBlocked && (phase === 'running' || phase === 'error') && (
                    <button type="button" disabled={runtimeControlsDisabled} onClick={() => void run('stop')}>{t('stop')}</button>
                  )}
                  <button type="button" disabled={!!working} onClick={() => {
                    setNotice('')
                    project.refresh()
                    void refresh()
                  }}>{t('refresh')}</button>
                  {working && <span role="status">{t('working')}</span>}
                </div>
                <div hidden={!settings || !enabled || !maintenanceAvailable || hostBlocked}>
                  <div className="appstudio-actions">
                    <button type="button" disabled={runtimeControlsDisabled} onClick={() => setConfirmation('uninstall')}>{t('uninstall')}</button>
                    <button type="button" disabled={!accepted || runtimeControlsDisabled} onClick={() => setConfirmation('reinitialize')}>{t('reinitialize')}</button>
                  </div>
                </div>
                {enabled && maintenanceAvailable && !hostBlocked && confirmation && (
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
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  )
}
