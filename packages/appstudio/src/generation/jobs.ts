import { createHash } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { candidatePathEditable, type CandidateEditScope } from '../iteration/candidate-scope.ts'
import type { CandidateLease } from '../iteration/candidate-tools.ts'
import { applyCandidateChanges, collectCandidateChanges, createCandidateMirror, type CandidateBaseline, type CandidateFile } from '../iteration/changes.ts'
import { readJson, saveJson } from '../project/job-state.ts'
import type { GenerationRequest, GenerationView } from '../shared/protocol.ts'
import { starterColumns, starterRows, validStarterBlockPositions } from '../shared/starter-layout.ts'
import type { GenerationCoordinator, GenerationExecution } from './contract.ts'
import type { GenerationBrief } from './prompt.ts'

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const designId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const screen = z.strictObject({
  id: designId,
  title: z.string().trim().min(1).max(80),
  blocks: z.array(z.strictObject({
    id: designId,
    kind: z.enum(['heading', 'text', 'image', 'input', 'button', 'list', 'divider']),
    text: z.string().trim().max(400),
    position: z.strictObject({
      row: z.number().int().min(0).max(starterRows - 1),
      column: z.number().int().min(0).max(starterColumns - 1),
      span: z.number().int().min(1).max(starterColumns),
    }).optional(),
  })).max(12),
})
const submission = z.strictObject({
  projectRoot: z.string().min(1).max(4096),
  batchId: z.string().regex(idPattern),
  framework: z.enum(['flutter', 'react-native', 'android']),
  mode: z.enum(['layout', 'prompt']),
  name: z.string().trim().max(80).regex(/^[^\u0000-\u001f]*$/),
  brief: z.string().trim().max(4000),
  layout: z.strictObject({ screens: z.array(screen).min(1).max(8) }).nullable(),
  retryOf: z.string().regex(idPattern).nullable(),
  repairNote: z.string().trim().max(2000),
})
const extensions = { flutter: ['.dart'], 'react-native': ['.ts', '.tsx', '.js', '.jsx'], android: ['.java'] } as const
const assetRoots = { flutter: ['assets'], 'react-native': ['src/assets'], android: ['app/src/main/assets'] } as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const terminal = (phase: GenerationView['phase']) => phase === 'applied' || phase === 'failed'

interface RetainedCandidate {
  baseline: CandidateBaseline
  starterFiles: CandidateFile[]
  editScope: CandidateEditScope
}

interface GenerationJob {
  requestHash: string
  brief: GenerationBrief
  mirrorBatch: string
  view: GenerationView
  candidate?: RetainedCandidate
  generatedFiles?: CandidateFile[]
  resumeBuild?: boolean
  publishFiles?: CandidateFile[]
}

function legacyRuntimeFailure(job: GenerationJob): boolean {
  // Older jobs logged the completed turn and runtime startup without a typed failure stage.
  const startup = '\nStarting the dedicated Android runtime.\n'
  const offset = job.view.log.lastIndexOf(startup)
  return !!job.candidate && offset >= 0 &&
    /(?:^|\n)DSH turn \d+ completed\.(?:\n|$)/u.test(job.view.log.slice(0, offset)) &&
    job.view.log.slice(offset + startup.length) === job.view.detail + '\n'
}

function validate(input: GenerationRequest): GenerationRequest {
  const parsed = submission.safeParse(input)
  if (!parsed.success) throw new Error('The generation request has invalid fields or exceeds its size limits.')
  const request = parsed.data
  if (request.layout?.screens.some(screen => !validStarterBlockPositions(screen.blocks))) {
    throw new Error('Layout blocks must fit inside the screen grid without overlapping.')
  }
  if (request.retryOf !== null) {
    if (request.retryOf === request.batchId) throw new Error('Use a new batch ID for a generation retry.')
    return request
  }
  if (!request.name || request.repairNote) throw new Error('Enter an app name before submitting generation.')
  if (request.mode === 'prompt') {
    if (!request.brief || request.layout !== null) throw new Error('Describe the app to generate in prompt mode.')
  } else {
    const screens = request.layout?.screens ?? []
    const count = screens.reduce((sum, entry) => sum + entry.blocks.length, 0)
    if (!count || count > 24 || new Set(screens.map(entry => entry.id)).size !== screens.length ||
        screens.some(entry => new Set(entry.blocks.map(block => block.id)).size !== entry.blocks.length)) {
      throw new Error('Add between one and 24 layout blocks with distinct IDs across the draft screens.')
    }
  }
  return request
}

async function requireEmptySource(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.some(entry => entry.name !== '.git' || (!entry.isDirectory() && !entry.isFile()))) {
    throw new Error('Choose an empty local project folder or a Git repository containing only .git.')
  }
}

function verifyGeneratedSource(candidate: RetainedCandidate, files: CandidateFile[]): void {
  const { starterFiles, editScope } = candidate
  const fixedFiles = (entries: CandidateFile[]) => entries.filter(file => !candidatePathEditable(file.path, editScope))
    .sort((left, right) => left.path.localeCompare(right.path))
  if (!isDeepStrictEqual(fixedFiles(starterFiles), fixedFiles(files))) {
    throw new Error('The generated project changed protected build or scene bridge files.')
  }
  const original = starterFiles.find(file => file.path === editScope.entry)
  const generated = files.find(file => file.path === editScope.entry)
  if (!original || !generated || original.sha256 === generated.sha256) {
    throw new Error('The Agent did not customize the starter application source. Retry in the same App Studio session.')
  }
}

/** Runs source generation through the same verified candidate build and publication path as iterations. */
export class GenerationJobs implements GenerationCoordinator {
  private admitting = false
  private active?: GenerationJob
  private task?: Promise<void>
  private lease?: CandidateLease & { sessionId: string }

  constructor(private readonly dataDir: string) {}

  isRunning(): boolean {
    return this.admitting || this.task !== undefined
  }

  async drain(): Promise<void> {
    await this.task
  }

  candidateFor(sessionId: string): CandidateLease | undefined {
    return this.lease?.sessionId === sessionId ? this.lease : undefined
  }

  async status(projectRoot: string): Promise<GenerationView | null> {
    if (this.active?.view.projectRoot === projectRoot) return this.active.view
    const directory = this.projectPath(projectRoot)
    const latest = await readJson<{ batchId: string }>(join(directory, 'latest.json'))
    if (!latest) return null
    const job = await this.readJob(directory, latest.batchId)
    return job ? (await this.recover(job)).view : null
  }

  async submit(input: GenerationRequest, execution: GenerationExecution): Promise<GenerationView> {
    const request = validate(input)
    const directory = this.projectPath(request.projectRoot)
    const requestHash = hash(JSON.stringify(request))
    if (this.admitting) throw new Error('A generation request is being accepted. Retry with the same batch ID.')
    this.admitting = true
    try {
      const existing = this.active?.view.batchId === request.batchId && this.active.view.projectRoot === request.projectRoot
        ? this.active : await this.readJob(directory, request.batchId)
      if (existing) {
        if (existing.requestHash !== requestHash) throw new Error('This generation ID already belongs to a different request.')
        return existing === this.active ? existing.view : (await this.recover(existing)).view
      }
      if (this.task || execution.project.isBusy() || execution.iterationBusy?.()) {
        throw new Error('Wait for the active App Studio build or Agent task to finish.')
      }
      execution.signal.throwIfAborted()
      await requireEmptySource(request.projectRoot)
      const { name, brief, layout, framework, mode } = request
      const requestedBrief = { name, brief, layout, framework, mode }
      const latest = await readJson<{ batchId: string }>(join(directory, 'latest.json'))
      const saved = latest && await this.readJob(directory, latest.batchId)
      const retained = saved && await this.recover(saved)
      let previous: GenerationJob | undefined
      if (request.retryOf !== null) {
        if (!retained || retained.view.batchId !== request.retryOf || retained.view.phase !== 'failed' ||
            retained.brief.mode !== request.mode || retained.brief.framework !== request.framework) {
          throw new Error('Retry only the latest failed generation in its original mode and framework.')
        }
        previous = retained
      } else if (retained?.view.phase === 'failed' && isDeepStrictEqual(retained.brief, requestedBrief)) {
        previous = retained
      }
      const view: GenerationView = {
        batchId: request.batchId, projectRoot: request.projectRoot, framework, mode,
        sessionId: previous?.view.sessionId ?? null, phase: 'queued', detail: 'Generation submitted.', log: '', project: null,
      }
      const resumeBuild = !request.repairNote && previous?.view.canRetryBuild === true
      const job: GenerationJob = {
        requestHash, view, brief: previous?.brief ?? requestedBrief,
        mirrorBatch: previous?.candidate ? previous.mirrorBatch : request.batchId, candidate: previous?.candidate,
        generatedFiles: resumeBuild ? previous?.generatedFiles : undefined,
        resumeBuild: resumeBuild || undefined,
      }
      await mkdir(join(directory, request.batchId), { recursive: true })
      await this.save(directory, job)
      await saveJson(join(directory, 'latest.json'), { batchId: request.batchId })
      this.active = job
      const task = this.run(directory, job, execution, request.repairNote, previous?.view.log ?? '')
      this.task = task
      void task.finally(() => { if (this.task === task) this.task = undefined }).catch(() => {})
      return view
    } finally {
      this.admitting = false
    }
  }

  private async run(
    directory: string, job: GenerationJob, execution: GenerationExecution, repairNote: string, previousLog: string,
  ): Promise<void> {
    const { view, brief } = job
    const { project, manager, adapter, signal } = execution
    const root = join(directory, job.mirrorBatch, 'candidate')
    let applied = false
    try {
      signal.throwIfAborted()
      if (!job.candidate) {
        await this.update(directory, job, 'scaffolding', 'Preparing the isolated starter project.')
        const baseline = await createCandidateMirror(view.projectRoot, root, signal)
        if (baseline.files.length) throw new Error('The source folder changed before generation began.')
        const scaffold = await execution.scaffold({
          framework: view.framework, root, batchId: job.mirrorBatch,
          brief: { title: brief.name, layout: brief.layout },
        }, signal)
        const { candidateFiles: starterFiles } = await collectCandidateChanges(baseline, signal)
        job.candidate = {
          baseline, starterFiles, editScope: {
            entry: scaffold.editableEntry, sourceRoots: scaffold.editableRoots, sourceExtensions: extensions[view.framework],
            assetRoots: assetRoots[view.framework], protectedPaths: scaffold.scenePaths,
          },
        }
        await this.save(directory, job)
      } else if (job.candidate.baseline.sourceRoot !== view.projectRoot || job.candidate.baseline.candidateRoot !== root) {
        throw new Error('The retained starter does not match the project folder.')
      }
      if (!view.sessionId) {
        view.sessionId = (await execution.createSession(view.projectRoot, signal)).id
        await this.save(directory, job)
      }
      if (job.resumeBuild) {
        await this.update(directory, job, 'building', 'Reusing the generated source and retrying build and launch.')
      } else {
        await this.update(directory, job, 'editing', 'Agent is generating the source. Open the generation session to follow its progress.')
        this.lease = { sessionId: view.sessionId, batchId: view.batchId, root, editScope: job.candidate.editScope }
        try {
          const { turn } = await execution.generate({
            projectRoot: view.projectRoot, sessionId: view.sessionId, batchId: view.batchId, brief,
            editScope: job.candidate.editScope, repairNote, previousLog: previousLog.slice(-12000),
          }, AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]))
          this.append(job, `DSH turn ${turn} completed.`)
        } finally {
          this.lease = undefined
        }
      }
      const changes = await collectCandidateChanges(job.candidate.baseline, signal)
      verifyGeneratedSource(job.candidate, changes.candidateFiles)
      if (job.resumeBuild && job.generatedFiles && !isDeepStrictEqual(job.generatedFiles, changes.candidateFiles)) {
        throw new Error('The retained generated source changed after validation. Add repair instructions to have the Agent review it.')
      }
      job.generatedFiles = changes.candidateFiles
      await this.update(directory, job, 'building', 'Building the generated Android app.')
      for await (const event of project.execute(manager, adapter, { projectRoot: view.projectRoot, framework: view.framework }, false, signal, {
        sourceRoot: root,
        onValidation: () => this.update(directory, job, 'validating', 'Launching the candidate and verifying its first scene checkpoint.'),
        beforePromote: async () => {
          await requireEmptySource(view.projectRoot)
          job.publishFiles = changes.candidateFiles
          await this.update(directory, job, 'validating', 'Applying the verified source to the empty project folder.')
          await applyCandidateChanges(changes, signal)
          applied = true
        },
      })) {
        if (event.kind === 'error') {
          view.canRetryBuild = event.stage === 'runtime-start'
          throw new Error(event.text)
        }
        if (event.kind === 'ready') view.project = event.project
        else {
          this.append(job, event.text)
          if (event.kind === 'progress') {
            if (event.stage === 'runtime-start') view.phase = 'starting'
            else if (view.phase === 'starting') view.phase = 'building'
            view.detail = event.text
          }
          await this.save(directory, job)
        }
      }
      signal.throwIfAborted()
      if (!applied || !view.project) throw new Error('The generated project did not finish validation.')
      await this.update(directory, job, 'applied', 'Project generated and applied. Live is preparing the first frame.')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.append(job, detail)
      view.canRetryBuild ??= !!job.generatedFiles && signal.aborted
      await this.update(directory, job, applied ? 'applied' : 'failed', applied
        ? 'Source was applied. Open the generated project in Live to continue.'
        : detail.slice(0, 1800)).catch(() => {})
    }
  }

  private append(job: GenerationJob, text: string): void {
    job.view.log = (job.view.log + text + '\n').slice(-48000)
  }

  private async update(directory: string, job: GenerationJob, phase: GenerationView['phase'], detail: string): Promise<void> {
    job.view.phase = phase
    job.view.detail = detail
    await this.save(directory, job)
  }

  private projectPath(root: string): string {
    return join(this.dataDir, hash(root.toLowerCase()))
  }

  private async readJob(directory: string, batchId: string): Promise<GenerationJob | undefined> {
    if (!idPattern.test(batchId)) throw new Error('Invalid saved generation ID.')
    return readJson<GenerationJob>(join(directory, batchId, 'state.json'))
  }

  private save(directory: string, job: GenerationJob): Promise<void> {
    return saveJson(join(directory, job.view.batchId, 'state.json'), job)
  }

  private async recover(job: GenerationJob): Promise<GenerationJob> {
    if (terminal(job.view.phase)) {
      if (job.view.phase === 'failed') job.view.canRetryBuild ??= legacyRuntimeFailure(job)
      return job
    }
    if (job.publishFiles && job.candidate) {
      const plan = await collectCandidateChanges({ ...job.candidate.baseline, files: job.publishFiles }).catch(() => undefined)
      if (plan?.count === 0) {
        job.view.phase = 'applied'
        job.view.detail = 'Source was applied before the Host stopped. Open the project in Live to continue.'
        return job
      }
    }
    job.view.phase = 'failed'
    job.view.canRetryBuild = !!job.generatedFiles || job.resumeBuild === true
    job.view.detail = job.view.canRetryBuild
      ? 'The Host stopped before build and launch finished. Retry with the retained source.'
      : 'The Host stopped before generation finished. Retry in the retained App Studio session.'
    return job
  }
}
