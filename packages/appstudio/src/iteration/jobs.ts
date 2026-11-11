import { createHash } from 'node:crypto'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ProjectRun } from '../project/run.ts'
import type { FrameworkCapability } from '../project/frameworks.ts'
import { readJson, saveJson } from '../project/job-state.ts'
import type { AndroidRuntimeManager } from '../runtime/manager.ts'
import type { IterationComment, IterationOutcome, IterationRequest, IterationView } from '../shared/protocol.ts'
import { IterationAdmissionError } from './admission.ts'
import { applyCandidateChanges, collectCandidateChanges, createCandidateMirror, type CandidateBaseline, type CandidateFile } from './changes.ts'

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const reportsFile = '.appstudio-iteration-result.json'
const isTerminal = (phase: IterationView['phase']) => phase === 'applied' || phase === 'failed'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

interface Job {
  requestHash: string
  comments: IterationComment[]
  mirrorBatch: string
  view: IterationView
  baseline?: CandidateBaseline
  candidateFiles?: CandidateFile[]
}

interface IterationExecution {
  project: ProjectRun
  manager: AndroidRuntimeManager
  adapter: FrameworkCapability
  signal: AbortSignal
  submit(input: {
    projectRoot: string; sessionId: string; batchId: string; comments: IterationComment[]
    repairNote: string; previousLog: string
  }, signal: AbortSignal): Promise<{ turn: number }>
}

function validFrame(frame: string): boolean {
  if (frame.length > 160000) return false
  const body = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(frame)?.[1]
  if (!body || body.length % 4 !== 0) return false
  const bytes = Buffer.from(body, 'base64')
  return bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9
}

function validate(request: IterationRequest): void {
  if (!idPattern.test(request.batchId) || !request.sessionId || request.sessionId.length > 256 ||
      request.repairNote.length > 2000) throw new IterationAdmissionError('Invalid iteration submission.')
  if (request.retryOf !== null) {
    if (!idPattern.test(request.retryOf) || request.retryOf === request.batchId || request.comments.length) {
      throw new IterationAdmissionError('Invalid iteration retry.')
    }
    return
  }
  if (!request.comments.length || request.comments.length > 10 || request.repairNote ||
      new Set(request.comments.map(comment => comment.id)).size !== request.comments.length) {
    throw new IterationAdmissionError('Submit between one and ten distinct comments.')
  }
  for (const comment of request.comments) {
    const { selection, frameWidth, frameHeight } = comment
    const numbers = [selection.x, selection.y, selection.width, selection.height, frameWidth, frameHeight]
    if (!idPattern.test(comment.id) || !comment.text.trim() || comment.text.length > 2000 ||
        !numbers.every(Number.isSafeInteger) || selection.x < 0 || selection.y < 0 || selection.width < 1 ||
        selection.height < 1 || selection.x + selection.width > frameWidth || selection.y + selection.height > frameHeight ||
        frameWidth > 8192 || frameHeight > 8192 ||
        (selection.kind === 'point' && (selection.width !== 1 || selection.height !== 1)) ||
        !validFrame(comment.frame)) throw new IterationAdmissionError('A comment has invalid coordinates, text, or a JPEG frame.')
  }
}

async function outcomes(root: string, comments: IterationComment[]): Promise<IterationOutcome[]> {
  const found = new Map<string, string>()
  try {
    const path = join(root, reportsFile)
    const info = await lstat(path)
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 24_000) {
      const value = await readJson<{ outcomes?: unknown }>(path)
      if (Array.isArray(value?.outcomes)) {
        for (const entry of value.outcomes) {
          if (typeof entry?.commentId === 'string' && typeof entry?.detail === 'string' && entry.detail.trim()) {
            found.set(entry.commentId, entry.detail.trim().slice(0, 1500))
          }
        }
      }
    }
  } catch {
    // An Agent report is supplemental to validation and patch application.
  }
  return comments.map(({ id, text }) => ({
    commentId: id,
    commentText: text,
    status: found.has(id) ? 'reported' : 'unverified',
    detail: found.get(id) ?? '',
  }))
}

/** Owns one accepted iteration at a time, independently of the Client connection. */
export class IterationJobs {
  private admitting = false
  private active?: Job
  private task?: Promise<void>
  private lease?: { sessionId: string; root: string; batchId: string }

  constructor(private readonly dataDir: string) {}

  isRunning(): boolean {
    return this.admitting || this.task !== undefined
  }

  async drain(): Promise<void> {
    await this.task
  }

  candidateFor(sessionId: string): { root: string; batchId: string } | undefined {
    if (this.lease?.sessionId === sessionId) {
      return { root: this.lease.root, batchId: this.lease.batchId }
    }
    return undefined
  }

  async status(projectRoot: string): Promise<IterationView | null> {
    if (this.active?.view.projectRoot === projectRoot) return this.active.view
    const directory = this.projectPath(projectRoot)
    const current = await readJson<{ batchId: string }>(join(directory, 'latest.json'))
    if (!current) return null
    const job = await this.readJob(directory, current.batchId)
    return job ? this.recover(job).view : null
  }

  async submit(request: IterationRequest, execution: IterationExecution): Promise<IterationView> {
    validate(request)
    const directory = this.projectPath(request.projectRoot)
    const requestHash = hash(JSON.stringify(request))
    if (this.admitting) throw new Error('An iteration submission is being accepted. Retry with the same batch ID.')
    this.admitting = true
    try {
      const existing = this.active?.view.batchId === request.batchId && this.active.view.projectRoot === request.projectRoot
        ? this.active : await this.readJob(directory, request.batchId)
      if (existing) {
        if (existing.requestHash !== requestHash) throw new IterationAdmissionError('This iteration ID already belongs to a different submission.')
        return existing === this.active ? existing.view : this.recover(existing).view
      }
      if (this.task || execution.project.isBusy()) throw new IterationAdmissionError('App Studio is already running a build or iteration.')
      execution.signal.throwIfAborted()
      const project = execution.project.status(execution.manager)
      if (!project.framework || project.projectRoot !== request.projectRoot) {
        throw new IterationAdmissionError('Run this project in Live before submitting an iteration.')
      }
      const background = project.activeRole === 'live' ? 'candidate' : 'live'
      if (!execution.manager.currentEndpoint()?.devices.some(device => device.id === background)) {
        throw new IterationAdmissionError('The background Android device must be ready before submitting an iteration.')
      }
      let previous: Job | undefined
      if (request.retryOf !== null) {
        const latest = await readJson<{ batchId: string }>(join(directory, 'latest.json'))
        previous = latest?.batchId === request.retryOf
          ? await this.readJob(directory, request.retryOf) : undefined
        if (!previous || this.recover(previous).view.phase !== 'failed' ||
            previous.view.sessionId !== request.sessionId || !previous.baseline) {
          throw new IterationAdmissionError('Only the latest failed iteration can be retried in its original session.')
        }
      }
      const retained = previous?.view.canRetryBuild === true && !request.repairNote.trim() ? previous : undefined
      const view: IterationView = {
        batchId: request.batchId, sessionId: request.sessionId, projectRoot: request.projectRoot,
        sourceDeploymentId: project.deploymentId,
        phase: 'queued', detail: 'Iteration submitted.', log: '', diff: '', project: null,
        outcomes: retained?.view.outcomes ?? [],
      }
      const job: Job = {
        requestHash, view, comments: previous?.comments ?? request.comments,
        mirrorBatch: previous?.mirrorBatch ?? request.batchId, baseline: previous?.baseline,
        candidateFiles: retained?.candidateFiles,
      }
      await mkdir(directory, { recursive: true })
      await mkdir(join(directory, request.batchId))
      await this.saveJob(directory, job)
      await saveJson(join(directory, 'latest.json'), { batchId: request.batchId })
      this.active = job
      const task = this.run(directory, job, execution, !!retained, request.repairNote, previous?.view.log ?? '')
      this.task = task
      void task.finally(() => { if (this.task === task) this.task = undefined }).catch(() => {})
      return view
    } finally {
      this.admitting = false
    }
  }

  private async run(
    directory: string, job: Job, execution: IterationExecution, retryBuild: boolean, repairNote: string, previousLog: string,
  ): Promise<void> {
    const { view } = job
    const { project, manager, adapter, signal } = execution
    let release: (() => void) | undefined
    let applied = false
    try {
      signal.throwIfAborted()
      const active = project.status(manager)
      if (!active.framework || active.projectRoot !== view.projectRoot || active.deploymentId !== view.sourceDeploymentId) {
        throw new Error('The active Live project changed.')
      }
      release = manager.acquireUse()
      const root = join(directory, job.mirrorBatch, 'candidate')
      if (!job.baseline) {
        job.baseline = await createCandidateMirror(view.projectRoot, root, signal)
      } else if (job.baseline.sourceRoot !== view.projectRoot || job.baseline.candidateRoot !== root) {
        throw new Error('The retained candidate does not match the project.')
      }
      if (retryBuild) {
        this.append(job, 'Retrying build and scene validation with the retained candidate.')
      } else {
        await rm(join(root, reportsFile), { force: true })
        await this.update(directory, job, 'editing', 'Agent is editing the candidate source.')
        this.lease = { sessionId: view.sessionId, batchId: view.batchId, root }
        try {
          const { turn } = await execution.submit({
            projectRoot: view.projectRoot, sessionId: view.sessionId, batchId: view.batchId,
            comments: job.comments, repairNote, previousLog: previousLog.slice(-12000),
          }, AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]))
          this.append(job, 'DSH turn ' + turn + ' completed.')
        } finally {
          this.lease = undefined
        }
        signal.throwIfAborted()
        view.outcomes = await outcomes(root, job.comments)
      }
      const retainedFiles = job.candidateFiles
      job.candidateFiles = undefined
      const changes = await collectCandidateChanges(job.baseline, signal)
      if (retainedFiles && !isDeepStrictEqual(retainedFiles, changes.candidateFiles)) {
        throw new Error('The retained candidate changed after its last build. Ask the Agent to review it before building again.')
      }
      view.diff = changes.diff
      if (!changes.count) throw new Error('The Agent produced no source changes to build.')
      job.candidateFiles = changes.candidateFiles
      await this.update(directory, job, 'building', 'Building the Agent candidate.')
      for await (const event of project.execute(manager, adapter, { projectRoot: view.projectRoot, framework: active.framework }, true, signal, {
        sourceRoot: root,
        onValidation: () => this.update(directory, job, 'validating', 'Validating the candidate and restoring the Live scene.'),
        beforePromote: async () => {
          await this.update(directory, job, 'validating', 'Applying validated source changes.')
          await applyCandidateChanges(changes, signal)
          applied = true
        },
      })) {
        if (event.kind === 'error') throw new Error(event.text)
        if (event.kind === 'log' || event.kind === 'progress') {
          this.append(job, event.text)
          await this.saveJob(directory, job)
        } else {
          view.project = event.project
        }
      }
      if (!applied || !view.project) throw new Error('Candidate validation did not complete.')
      await this.update(directory, job, 'applied', 'Validated changes applied. Live is switching to the restored candidate.')
    } catch (error) {
      this.append(job, message(error))
      if (!applied) view.canRetryBuild = job.candidateFiles !== undefined
      await this.update(directory, job, applied ? 'applied' : 'failed', applied
        ? 'Source changes were applied. Check Live status before continuing.'
        : message(error).slice(0, 1800)).catch(() => {})
    } finally {
      release?.()
    }
  }

  private append(job: Job, text: string): void {
    job.view.log = (job.view.log + text + '\n').slice(-48000)
  }

  private async update(directory: string, job: Job, phase: IterationView['phase'], detail: string): Promise<void> {
    job.view.phase = phase
    job.view.detail = detail
    await this.saveJob(directory, job)
  }

  private projectPath(root: string): string {
    return join(this.dataDir, hash(root.toLowerCase()))
  }

  private async readJob(directory: string, batchId: string): Promise<Job | undefined> {
    if (!idPattern.test(batchId)) throw new Error('Invalid saved iteration ID.')
    return readJson<Job>(join(directory, batchId, 'state.json'))
  }

  private saveJob(directory: string, job: Job): Promise<void> {
    return saveJson(join(directory, job.view.batchId, 'state.json'), job)
  }

  private recover(job: Job): Job {
    if (!isTerminal(job.view.phase)) {
      job.view.phase = 'failed'
      job.view.detail = 'The Host stopped before this iteration finished. Inspect the DSH session and retained candidate before retrying.'
    }
    if (job.view.phase === 'failed') {
      // Older jobs recorded this step after collecting the Agent's changes, before storing the candidate manifest.
      job.view.canRetryBuild ??= !!job.baseline && (job.candidateFiles !== undefined ||
        (!!job.view.diff && /(?:^|\n)(?:Building a standalone debug APK inside WSL2\.|Restarting the app on the candidate device and restoring the current scene\.)(?:\n|$)/u.test(job.view.log)))
    }
    return job
  }
}
