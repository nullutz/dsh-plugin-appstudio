import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { GenerationExecution } from '../src/generation/contract.ts'
import { GenerationJobs } from '../src/generation/jobs.ts'
import { generationPrompt } from '../src/generation/prompt.ts'
import { createScaffolder } from '../src/generation/scaffold.ts'
import { CandidateFiles } from '../src/iteration/candidate-tools.ts'
import type { GenerationRequest, ProjectRunEvent } from '../src/shared/protocol.ts'

const scaffold = createScaffolder(new URL('../scaffold/', import.meta.url))
const session = { id: 'app-studio-test-session', title: 'Studio test', updatedAt: 0 }

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'appstudio-generation-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, 'project')
  await mkdir(join(projectRoot, '.git'), { recursive: true })
  await writeFile(join(projectRoot, '.git', 'keep'), 'untouched')
  const dataDir = join(root, 'jobs')
  const request: GenerationRequest = {
    projectRoot, batchId: randomUUID(), framework: 'android', mode: 'prompt',
    name: 'Device notes', brief: 'An Android app for device notes', layout: null, retryOf: null, repairNote: '',
  }
  return { projectRoot, dataDir, request }
}

function execution(overrides: Partial<GenerationExecution> = {}): GenerationExecution {
  return {
    manager: {} as GenerationExecution['manager'], adapter: {} as GenerationExecution['adapter'],
    signal: new AbortController().signal,
    project: {
      isBusy: () => false,
      async *execute(_manager, _adapter, config, rebuild, _signal, candidate): AsyncIterable<ProjectRunEvent> {
        assert.equal(rebuild, false)
        assert(candidate)
        assert.deepEqual(await readdir(config.projectRoot), ['.git'])
        await candidate.onValidation()
        yield { kind: 'log', text: 'A new process exported the initial checkpoint.' }
        await candidate.beforePromote()
        yield {
          kind: 'ready', project: { ...config, activeRole: 'candidate', applicationId: 'dev.appstudio.generated', versionCode: '1', restored: false },
        }
      },
    } as GenerationExecution['project'],
    scaffold,
    createSession: async () => session,
    generate: async () => { throw new Error('The test must implement its DSH turn.') },
    ...overrides,
  }
}

test('publishes the verified generated source and preserves the Git repository', async t => {
  const { dataDir, request, projectRoot } = await fixture(t)
  const jobs = new GenerationJobs(dataDir)
  let turns = 0
  let entry = ''
  const host = execution({
    async generate(input, signal) {
      turns++
      assert.equal(input.sessionId, session.id)
      assert.equal(input.brief.brief, request.brief)
      assert.deepEqual(await readdir(projectRoot), ['.git'])
      const lease = jobs.candidateFor(session.id)
      assert(lease?.editScope)
      assert.equal(jobs.candidateFor('other-session'), undefined)
      const files = new CandidateFiles(projectRoot, () => jobs.candidateFor(session.id))
      entry = input.editScope.entry
      const before = await readFile(join(lease.root, entry), 'utf8')
      await assert.rejects(files.write('gradle.properties', 'hostile configuration', signal), /protected/)
      await assert.rejects(files.delete(input.editScope.protectedPaths[0], signal), /protected/)
      await assert.rejects(files.write(input.editScope.sourceRoots[0] + '/build.sh', 'hostile build hook', signal), /protected/)
      await files.write(input.editScope.sourceRoots[0] + '/screens/Notes.java', 'final class Notes {}\n', signal)
      await files.edit(entry, before, before + '\n// Generated notes app\n', signal)
      return { turn: 1 }
    },
  })
  await jobs.submit(request, host)
  await jobs.drain()
  const recovered = new GenerationJobs(dataDir)
  const view = await recovered.status(projectRoot)
  assert.equal(view?.phase, 'applied', view?.log)
  assert.equal(view?.sessionId, session.id)
  assert.equal(view?.project?.activeRole, 'candidate')
  assert.match(await readFile(join(projectRoot, entry), 'utf8'), /Generated notes app/)
  assert.equal(await readFile(join(projectRoot, '.git', 'keep'), 'utf8'), 'untouched')
  assert.equal((await recovered.submit(request, host)).phase, 'applied')
  assert.equal(turns, 1)
})

test('retains the failed candidate and original layout for repair in the same session', async t => {
  const { dataDir, request: empty, projectRoot } = await fixture(t)
  const request: GenerationRequest = {
    ...empty, mode: 'layout', brief: '',
    layout: { screens: [{ id: 'home', title: 'Home', blocks: [
      { id: 'notes', kind: 'list', text: 'Notes', position: { row: 0, column: 0, span: 8 } },
      { id: 'add', kind: 'button', text: 'New', position: { row: 0, column: 8, span: 4 } },
    ] }] },
  }
  const first = new GenerationJobs(dataDir)
  let previousRoot = ''
  const failedProject = {
    isBusy: () => false,
    async *execute(): AsyncIterable<ProjectRunEvent> { yield { kind: 'error', text: 'Simulated APK build diagnostic' } },
  } as GenerationExecution['project']
  await first.submit(request, execution({
    project: failedProject,
    async generate(input, signal) {
      const lease = first.candidateFor(session.id)!
      previousRoot = lease.root
      const files = new CandidateFiles(projectRoot, () => first.candidateFor(session.id))
      const before = await readFile(join(lease.root, input.editScope.entry), 'utf8')
      await files.edit(input.editScope.entry, before, before + '\n// First attempt\n', signal)
      return { turn: 1 }
    },
  }))
  await first.drain()
  const failed = await first.status(projectRoot)
  assert.equal(failed?.phase, 'failed')
  assert.equal(failed.canRetryBuild, false)
  assert.deepEqual(await readdir(projectRoot), ['.git'])

  const retry = new GenerationJobs(dataDir)
  await retry.submit({ ...request, batchId: randomUUID(), retryOf: request.batchId, repairNote: 'Repair build', name: '', layout: null }, execution({
    createSession: async () => { throw new Error('Retry unexpectedly created another DSH session.') },
    async generate(input, signal) {
      assert.equal(retry.candidateFor(session.id)?.root, previousRoot)
      assert.equal(input.brief.name, request.name)
      assert.deepEqual(input.brief.layout, request.layout)
      assert.match(generationPrompt(input), /Blocks sharing a row belong side by side/)
      assert.equal(input.repairNote, 'Repair build')
      assert.match(input.previousLog, /APK build diagnostic/)
      const files = new CandidateFiles(projectRoot, () => retry.candidateFor(session.id))
      await files.edit(input.editScope.entry, '// First attempt', '// Repaired', signal)
      return { turn: 2 }
    },
  }))
  await retry.drain()
  const repaired = await retry.status(projectRoot)
  assert.equal(repaired?.phase, 'applied', repaired?.log)
  assert.equal(repaired.sessionId, session.id)
})

test('rejects overlapping or overflowing layout blocks before creating a DSH session', async t => {
  const { dataDir, request, projectRoot } = await fixture(t)
  const jobs = new GenerationJobs(dataDir)
  for (const column of [4, 11]) {
    await assert.rejects(jobs.submit({
      ...request, mode: 'layout', brief: '', layout: { screens: [{ id: 'home', title: 'Home', blocks: [
        { id: 'notes', kind: 'list', text: 'Notes', position: { row: 0, column: 0, span: 8 } },
        { id: 'add', kind: 'button', text: 'New', position: { row: 0, column, span: 4 } },
      ] }] },
    }, execution()), /inside the screen grid without overlapping/)
  }
  assert.equal(await jobs.status(projectRoot), null)
})

for (const legacy of [false, true]) {
  test(`retries Android runtime startup with the retained source${legacy ? ' from a legacy job' : ''}`, async t => {
    const { dataDir, request: empty, projectRoot } = await fixture(t)
    const request: GenerationRequest = legacy ? {
      ...empty, mode: 'layout', brief: '', layout: { screens: [{ id: 'home', title: 'Home', blocks: [
        { id: 'notes', kind: 'list', text: 'Notes' },
      ] }] },
    } : empty
    const first = new GenerationJobs(dataDir)
    let entry = ''
    const failedProject = {
      isBusy: () => false,
      async *execute(): AsyncIterable<ProjectRunEvent> {
        yield { kind: 'progress', text: 'Starting the dedicated Android runtime.', stage: 'runtime-start' }
        assert.equal((await first.status(projectRoot))?.phase, 'starting')
        yield { kind: 'error', text: 'Could not create the live Android virtual device.', stage: 'runtime-start' }
      },
    } as GenerationExecution['project']
    await first.submit(request, execution({
      project: failedProject,
      async generate(input, signal) {
        const lease = first.candidateFor(session.id)!
        entry = input.editScope.entry
        const files = new CandidateFiles(projectRoot, () => first.candidateFor(session.id))
        const before = await readFile(join(lease.root, entry), 'utf8')
        await files.edit(entry, before, before + '\n// Generated notes app\n', signal)
        return { turn: 1 }
      },
    }))
    await first.drain()
    assert.deepEqual(await readdir(projectRoot), ['.git'])

    if (legacy) {
      const [directory] = await readdir(dataDir)
      const statePath = join(dataDir, directory, request.batchId, 'state.json')
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      delete state.generatedFiles
      delete state.view.canRetryBuild
      await writeFile(statePath, JSON.stringify(state))
    }
    const retry = new GenerationJobs(dataDir)
    const failed = await retry.status(projectRoot)
    assert.equal(failed?.phase, 'failed')
    assert.equal(failed.canRetryBuild, true)
    // A second click on Generate and run from an older Client still uses the retained job.
    await retry.submit({ ...request, batchId: randomUUID() }, execution({
      createSession: async () => { throw new Error('Retry unexpectedly created another DSH session.') },
    }))
    await retry.drain()
    const applied = await retry.status(projectRoot)
    assert.equal(applied?.phase, 'applied', applied?.log)
    assert.equal(applied.sessionId, session.id)
    assert.match(await readFile(join(projectRoot, entry), 'utf8'), /Generated notes app/)
  })
}

test('rejects nonempty workspaces and refuses to build a modified trusted scene bridge', async t => {
  const { dataDir, request, projectRoot } = await fixture(t)
  const jobs = new GenerationJobs(dataDir)
  const cache = join(projectRoot, '.gradle')
  await mkdir(cache)
  await assert.rejects(jobs.submit(request, execution()), /empty local project folder/)
  await rm(cache, { recursive: true })
  await jobs.submit(request, execution({
    async generate(input) {
      const lease = jobs.candidateFor(session.id)!
      await writeFile(join(lease.root, input.editScope.protectedPaths[0]), 'unexpected bridge content')
      return { turn: 1 }
    },
  }))
  await jobs.drain()
  assert.match((await jobs.status(projectRoot))?.detail ?? '', /changed protected build or scene bridge/)
  assert.deepEqual(await readdir(projectRoot), ['.git'])
})
