import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AndroidRuntimeManager, RuntimeEndpoint, RuntimeProcessOptions } from '../runtime/manager.ts'
import type { ProjectRunConfig, ProjectRunEvent, ProjectView } from '../shared/protocol.ts'
import { captureScene, deployProject } from './device.ts'
import type { FrameworkCapability } from './frameworks.ts'
import { projectArchive, projectDirectory } from './source.ts'

const empty: ProjectView = { activeRole: 'live', projectRoot: '', framework: null, applicationId: '', versionCode: '', restored: false }
const marker = { flutter: 'pubspec.yaml', 'react-native': 'package-lock.json', android: 'gradlew' }

export interface CandidateRun {
  sourceRoot: string
  onValidation(): Promise<void>
  beforePromote(): Promise<void>
}

/** Coordinates the active project and candidate for one Host composition. */
export class ProjectRun {
  private active?: { endpoint: RuntimeEndpoint; view: ProjectView }
  private busy = false

  status(manager: AndroidRuntimeManager | undefined): ProjectView {
    return this.active && manager?.currentEndpoint() === this.active.endpoint ? this.active.view : empty
  }

  isBusy(): boolean {
    return this.busy
  }

  async *execute(
    manager: AndroidRuntimeManager, adapter: FrameworkCapability, config: ProjectRunConfig, rebuild: boolean,
    signal: AbortSignal, candidate?: CandidateRun,
  ): AsyncIterable<ProjectRunEvent> {
    if (this.busy) {
      yield { kind: 'error', text: 'A project build is already running.' }
      return
    }
    this.busy = true
    let release: (() => void) | undefined
    try {
      signal.throwIfAborted()
      const projectRoot = await projectDirectory(config.projectRoot)
      const sourceRoot = candidate ? await projectDirectory(candidate.sourceRoot) : projectRoot
      const { framework } = config
      await access(join(sourceRoot, marker[framework])).catch(() => {
        throw new Error('The project directory is missing ' + marker[framework] + '.')
      })
      const current = this.status(manager)
      const same = current.framework === framework && current.projectRoot.toLowerCase() === projectRoot.toLowerCase()
      if (rebuild && !same) throw new Error('Run this project before rebuilding and restoring its scene.')
      if (!rebuild && same) throw new Error('Use Rebuild and restore to keep the active test scene.')
      yield { kind: 'progress', text: 'Starting the dedicated Android runtime.' }
      const endpoint = await manager.start()
      signal.throwIfAborted()
      release = manager.acquireUse()
      const run = (args: readonly string[], options?: RuntimeProcessOptions) =>
        manager.runProjectCommand(endpoint, args, { ...options, signal })

      yield { kind: 'progress', text: 'Preparing the pinned Linux build tools.' }
      const toolLog = await manager.prepareBuildTools(endpoint, framework, signal)
      if (toolLog.trim()) yield { kind: 'log', text: toolLog.trim().slice(-24000) }

      const deploymentId = randomUUID()
      const staging = '/opt/appstudio/projects/' + deploymentId.replaceAll('-', '') + '/source'
      yield { kind: 'progress', text: 'Copying the project source into the dedicated runtime.' }
      const directory = await run(['/usr/bin/install', '-d', '-m', '0700', staging], { timeoutMs: 30_000 })
      if (directory.code !== 0) throw new Error('Cannot create the Linux project staging directory.')
      const copied = await run(['/bin/tar', '--extract', '--file=-', '--directory', staging, '--no-same-owner', '--no-same-permissions'],
        { inputStream: projectArchive(sourceRoot), timeoutMs: 300_000 })
      if (copied.code !== 0) throw new Error('Cannot stage the project source. ' + copied.stderr.trim().slice(-1500))

      yield { kind: 'progress', text: 'Building a standalone debug APK inside WSL2.' }
      let log = ''
      let artifact
      try {
        artifact = await adapter.build(run, { projectDir: staging, signal, onLog: (chunk) => {
          log = (log + chunk).slice(-24000)
        } })
      } finally {
        if (!signal.aborted && log.trim()) yield { kind: 'log', text: log.trim() }
      }
      if (rebuild && artifact.applicationId !== current.applicationId) {
        throw new Error('The new APK uses a different application ID. The active test scene was kept.')
      }
      await candidate?.onValidation()
      const currentRole = current.framework ? current.activeRole : undefined
      const role = currentRole === 'live' || (!currentRole && candidate) ? 'candidate' : 'live'
      let scene = rebuild ? await captureScene(endpoint, current.activeRole, current.applicationId, signal) : undefined
      yield { kind: 'progress', text: scene ? 'Restarting the app on the candidate device and restoring the current scene.' : 'Installing and launching the debug app.' }
      let deployed = await deployProject(endpoint, role, artifact, scene, signal)
      if (scene) {
        const latest = await captureScene(endpoint, current.activeRole, current.applicationId, signal)
        if (!isDeepStrictEqual(scene, latest)) {
          yield { kind: 'progress', text: 'The current scene changed. Restoring the latest checkpoint before switching.' }
          scene = latest
          deployed = await deployProject(endpoint, role, artifact, scene, signal)
          const stable = await captureScene(endpoint, current.activeRole, current.applicationId, signal)
          if (!isDeepStrictEqual(scene, stable)) throw new Error('The current scene changed again. The active app is still available. Rebuild when the scene is stable.')
        }
      }
      signal.throwIfAborted()
      if (manager.currentEndpoint() !== endpoint) throw new Error('The Android runtime stopped during the project run.')
      yield { kind: 'log', text: `Verified Android version ${deployed.checkpoint.versionCode}, PID ${deployed.pid} on ${role}.` +
        (scene ? ` Restored the checkpoint from PID ${scene.pid} (version ${scene.versionCode}).` : '') }
      const view: ProjectView = {
        activeRole: role, deploymentId, projectRoot, framework, applicationId: artifact.applicationId,
        versionCode: deployed.checkpoint.versionCode, restored: deployed.sceneRestored,
      }
      if (candidate) {
        signal.throwIfAborted()
        if (manager.currentEndpoint() !== endpoint) throw new Error('The Android runtime stopped before applying the candidate.')
        await candidate.beforePromote()
      }
      this.active = { endpoint, view }
      yield { kind: 'ready', project: view }
    } catch (error) {
      if (!signal.aborted) yield { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    } finally {
      release?.()
      this.busy = false
    }
  }
}
