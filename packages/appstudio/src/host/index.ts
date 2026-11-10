import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { DeviceRole, FrameworkId, GenerationMode, GenerationRequest, GenerationView,
  IterationRequest, IterationSession, IterationView,
  ProjectRunConfig, ProjectRunEvent, ProjectView, RuntimeView } from '../shared/protocol.ts'
import { createScaffolder } from '../generation/scaffold.ts'
import { frameworks, frameworkService } from '../project/frameworks.ts'
import { ProjectRun } from '../project/run.ts'
import { projectDirectory } from '../project/source.ts'
import type { RuntimeStatus } from '../runtime/manager.ts'
import type {} from './android.ts'
import type {} from './commenting.ts'
import type { IterationFeature } from './agent.ts'
import type {} from './iterations.ts'
import type {} from './starter.ts'
import { relaySignaling } from './signaling.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    appStudio: AppStudio
  }
}

export default class AppStudio extends TypertRemoteService {
  private readonly lifetime = new AbortController()
  private readonly projects = new ProjectRun()
  private readonly scaffold = createScaffolder(new URL('../scaffold/', import.meta.url))

  constructor(ctx: Context) {
    super(ctx, 'appStudio')
    ctx.effect(() => () => this.lifetime.abort())
  }

  /** Read the Android environment status without starting WSL. */
  @Remote
  async status(): Promise<RuntimeView> {
    const android = this.ctx.get('appStudioAndroid')
    if (!android) return {
      phase: 'unsupported', detail: 'Android Runtime component is disabled.', androidEnabled: false,
      devices: [], frameworks: [], commentingEnabled: false, iterationEnabled: false,
      layoutEnabled: false, promptEnabled: false,
    }
    return this.runtimeView(await android.manager.status())
  }

  /** Read the project currently deployed to the running Android runtime. */
  @Remote
  async projectStatus(): Promise<ProjectView> {
    return this.projects.status(this.ctx.get('appStudioAndroid')?.manager)
  }

  /** Read the most recent starter job for the project, including retained failures. */
  @Remote
  async generationStatus(projectRoot: string): Promise<GenerationView | null> {
    const feature = this.agentFeature
    if (!feature || (!this.starter('layout') && !this.starter('prompt'))) return null
    return feature.generation.status(await projectDirectory(projectRoot))
  }

  /** Generate and validate a project for an empty source folder in a dedicated session. */
  @Remote
  async submitGeneration(request: GenerationRequest): Promise<GenerationView> {
    const feature = this.agentFeature
    const starter = this.starter(request.mode)
    if (!feature || !starter) {
      throw new RemoteError('gateway/bad-request', 'Enable App Studio Agent and the selected starter component in DSH Plugin Manager.', {})
    }
    const android = this.android
    const adapter = this.framework(request.framework)
    if (!adapter) throw new RemoteError('gateway/bad-request', 'Enable the selected framework component in DSH Plugin Manager.', {})
    const projectRoot = await projectDirectory(request.projectRoot)
    return feature.generation.submit({ ...request, projectRoot }, {
      project: this.projects, manager: android.manager, adapter, scaffold: this.scaffold,
      signal: AbortSignal.any([this.lifetime.signal, android.lifetime.signal, feature.signal, starter, adapter.signal]),
      createSession: (root, signal) => feature.sessions.create(root, signal),
      generate: (input, signal) => feature.sessions.generate(input, signal),
      iterationBusy: () => feature.jobs.isRunning(),
    })
  }

  /** List App Studio's dedicated sessions for this project. */
  @Remote
  async listIterationSessions(projectRoot: string, signal: AbortSignal): Promise<IterationSession[]> {
    return this.iterations.sessions.list(await projectDirectory(projectRoot), signal)
  }

  /** Create a dedicated App Studio session in the project's DSH workspace. */
  @Remote
  async createIterationSession(projectRoot: string, signal: AbortSignal): Promise<IterationSession> {
    return this.iterations.sessions.create(await projectDirectory(projectRoot), signal)
  }

  /** Read the latest submitted iteration across workbench reconnects. */
  @Remote
  async iterationStatus(projectRoot: string): Promise<IterationView | null> {
    return this.iterationFeature?.jobs.status(await projectDirectory(projectRoot)) ?? null
  }

  /** Accept one user-submitted batch and run it independently of the Client connection. */
  @Remote
  async submitIteration(request: IterationRequest): Promise<IterationView> {
    const iteration = this.iterations
    const android = this.android
    const projectRoot = await projectDirectory(request.projectRoot)
    if (iteration.generation.isRunning()) {
      throw new RemoteError('gateway/bad-request', 'Wait for the active App Studio starter job to finish.', {})
    }
    const project = this.projects.status(android.manager)
    const adapter = project.framework ? this.framework(project.framework) : undefined
    if (!adapter) throw new RemoteError('gateway/bad-request', 'Run a project with an enabled framework before submitting an iteration.', {})
    return iteration.jobs.submit({ ...request, projectRoot }, {
      project: this.projects, manager: android.manager, adapter,
      signal: AbortSignal.any([this.lifetime.signal, android.lifetime.signal, iteration.signal, adapter.signal]),
      submit: (input, signal) => iteration.sessions.submit(input, signal),
    })
  }

  /** Build, deploy and launch an Android project in the dedicated runtime. */
  @Remote({ mode: 'stream' })
  async *runProject(config: ProjectRunConfig, signal: AbortSignal): RemoteStream<ProjectRunEvent> {
    yield* this.executeProject(config, false, signal)
  }

  /** Build and restore the current scene on the other Android device before switching. */
  @Remote({ mode: 'stream' })
  async *rebuildProject(config: ProjectRunConfig, signal: AbortSignal): RemoteStream<ProjectRunEvent> {
    yield* this.executeProject(config, true, signal)
  }

  /** Provision the persistent Android environment. */
  @Remote
  async prepare(licenseAccepted: boolean): Promise<RuntimeView> {
    return this.runtimeView(await this.android.manager.prepare(licenseAccepted))
  }

  /** Start the existing Live and Candidate Android devices. */
  @Remote
  async start(): Promise<RuntimeView> {
    const manager = this.android.manager
    try {
      await manager.start()
    } catch (error) {
      const status = await manager.status()
      if (status.phase === 'error') return this.runtimeView(status)
      throw error
    }
    return this.status()
  }

  /** Stop the Android devices and suspend the dedicated WSL environment. */
  @Remote
  async stop(): Promise<RuntimeView> {
    this.requireAgentIdle()
    return this.runtimeView(await this.android.manager.stop())
  }

  /** Remove the Android environment owned by this DSH installation. */
  @Remote
  async uninstall(): Promise<RuntimeView> {
    this.requireAgentIdle()
    return this.runtimeView(await this.android.manager.uninstall())
  }

  /** Recreate the Android environment owned by this DSH installation. */
  @Remote
  async reinitialize(licenseAccepted: boolean): Promise<RuntimeView> {
    this.requireAgentIdle()
    return this.runtimeView(await this.android.manager.reinitialize(licenseAccepted))
  }

  /** Keep the Android runtime awake while a workbench is using it. */
  @Remote({ mode: 'stream' })
  async *holdRuntime(signal: AbortSignal): RemoteStream<boolean> {
    const android = this.android
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, android.lifetime.signal])
    lifetime.throwIfAborted()
    const release = android.manager.acquireUse()
    let close = () => {}
    try {
      const closed = new Promise<void>((resolve) => {
        close = resolve
        lifetime.addEventListener('abort', close, { once: true })
      })
      yield true
      await closed
    } finally {
      lifetime.removeEventListener('abort', close)
      release()
    }
  }

  /** Exchange WebRTC signaling and device input with a running Android device. */
  @Remote({ mode: 'stream' })
  async *signaling(role: DeviceRole, signal: AbortSignal): RemoteStream<string, string> {
    const android = this.android
    const endpoint = android.manager.currentEndpoint()
    const device = endpoint?.devices.find((entry) => entry.id === role)
    if (!endpoint || !device) throw new RemoteError('gateway/bad-request', 'Android device is not running.', {})
    const invocation = this.ctx.invocation
    if (!invocation) throw new RemoteError('gateway/internal', 'Android signaling requires a DSH connection.', {})
    yield* relaySignaling(endpoint, device, invocation.uplink<string>(), AbortSignal.any([signal, this.lifetime.signal, android.lifetime.signal]))
  }

  private get android() {
    const android = this.ctx.get('appStudioAndroid')
    if (!android) throw new RemoteError('gateway/bad-request', 'Android Runtime component is disabled.', {})
    android.lifetime.signal.throwIfAborted()
    return android
  }

  private runtimeView(status: RuntimeStatus): RuntimeView {
    const commentingEnabled = this.ctx.get('appStudioCommenting') === true
    return {
      ...status, androidEnabled: true, frameworks: frameworks.filter((id) => this.framework(id)),
      commentingEnabled, iterationEnabled: commentingEnabled && this.iterationFeature !== undefined,
      layoutEnabled: !!this.agentFeature && !!this.starter('layout'),
      promptEnabled: !!this.agentFeature && !!this.starter('prompt'),
    }
  }

  private starter(mode: GenerationMode): AbortSignal | undefined {
    if (mode === 'layout') return this.ctx.get('appStudioLayout')
    if (mode === 'prompt') return this.ctx.get('appStudioPrompt')
    return undefined
  }

  private framework(id: FrameworkId) {
    return this.ctx.get(frameworkService[id])
  }

  private async *executeProject(config: ProjectRunConfig, rebuild: boolean, signal: AbortSignal): AsyncIterable<ProjectRunEvent> {
    if (this.agentBusy()) {
      yield { kind: 'error', text: 'Wait for the active App Studio Agent job to finish.' }
      return
    }
    const android = this.android
    const adapter = this.framework(config.framework)
    if (!adapter) {
      yield { kind: 'error', text: 'Enable the selected framework component in DSH Plugin Manager.' }
      return
    }
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, android.lifetime.signal, adapter.signal])
    yield* this.projects.execute(android.manager, adapter, config, rebuild, lifetime)
  }

  private get iterations() {
    const feature = this.iterationFeature
    if (!feature || !this.ctx.get('appStudioCommenting')) {
      throw new RemoteError('gateway/bad-request', 'Enable App Studio commenting and Agent iteration in DSH Plugin Manager.', {})
    }
    feature.signal.throwIfAborted()
    return feature
  }

  private get iterationFeature() {
    return this.ctx.get('appStudioIterationEnabled') ? this.agentFeature : undefined
  }

  private get agentFeature(): IterationFeature | undefined {
    return this.ctx.get('appStudioIterations')
  }

  private agentBusy(): boolean {
    const feature = this.agentFeature
    return !!feature && (feature.jobs.isRunning() || feature.generation.isRunning())
  }

  private requireAgentIdle(): void {
    if (this.agentBusy()) {
      throw new RemoteError('gateway/bad-request', 'Wait for the active App Studio Agent job to finish.', {})
    }
  }
}
