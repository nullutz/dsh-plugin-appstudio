import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { IterationAdmissionError } from '../src/iteration/admission.ts'
import { IterationJobs } from '../src/iteration/jobs.ts'
import type { IterationRequest, ProjectView } from '../src/shared/protocol.ts'

type Execution = Parameters<IterationJobs['submit']>[1]

async function failedBuild(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'appstudio-iteration-retry-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, 'project')
  const dataDir = join(root, 'jobs')
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, 'app.txt'), 'Live source')
  const request: IterationRequest = {
    projectRoot, batchId: randomUUID(), sessionId: 'appstudio-session', retryOf: null, repairNote: '',
    comments: [{ id: randomUUID(), text: 'Update the app', frameWidth: 10, frameHeight: 10,
      selection: { kind: 'point', x: 1, y: 1, width: 1, height: 1 }, frame: 'data:image/jpeg;base64,/9j/2Q==' }],
  }
  let project: ProjectView = {
    projectRoot, deploymentId: randomUUID(), activeRole: 'live', framework: 'flutter',
    applicationId: 'dev.appstudio.test', versionCode: '1', restored: false,
  }
  const jobs = new IterationJobs(dataDir)
  const signal = new AbortController().signal
  let candidateRoot = ''
  let fail = true
  const execute: Execution['project']['execute'] = async function* (_manager, _adapter, _config, rebuild, _signal, candidate) {
    assert(rebuild)
    assert(candidate)
    assert.equal(candidate.sourceRoot, candidateRoot)
    assert.equal(await readFile(join(projectRoot, 'app.txt'), 'utf8'), 'Live source')
    assert.equal(await readFile(join(candidateRoot, 'app.txt'), 'utf8'), 'Candidate source')
    yield { kind: 'progress', text: 'Building a standalone debug APK inside WSL2.' }
    await candidate.onValidation()
    if (fail) {
      yield { kind: 'error', text: 'The app did not restore the captured scene in its new process.' }
      return
    }
    await candidate.beforePromote()
    project = { ...project, deploymentId: randomUUID(), activeRole: 'candidate', restored: true }
    yield { kind: 'ready', project }
  }
  const host: Execution = {
    manager: {
      acquireUse: () => () => {},
      currentEndpoint: () => ({ devices: [{ id: 'live' }, { id: 'candidate' }] }),
    } as Execution['manager'],
    adapter: {} as Execution['adapter'], signal,
    project: { status: () => project, isBusy: () => false, execute } as Execution['project'],
    async submit() {
      const lease = jobs.candidateFor(request.sessionId)
      assert(lease)
      candidateRoot = lease.root
      await writeFile(join(candidateRoot, 'app.txt'), 'Candidate source')
      return { turn: 1 }
    },
  }
  await jobs.submit(request, host)
  await jobs.drain()
  const failed = await jobs.status(projectRoot)
  assert.equal(failed?.phase, 'failed')
  assert.equal(failed.canRetryBuild, true)
  assert.equal(failed.sourceDeploymentId, project.deploymentId)
  const retry: IterationRequest = { ...request, batchId: randomUUID(), retryOf: request.batchId, comments: [] }
  const projectKey = createHash('sha256').update(projectRoot.toLowerCase()).digest('hex')
  return {
    projectRoot, candidateRoot, retry,
    stateFile: join(dataDir, projectKey, request.batchId, 'state.json'),
    reopen: () => new IterationJobs(dataDir),
    prepareRetry() {
      fail = false
      project = { ...project, deploymentId: randomUUID() }
      return { sourceDeploymentId: project.deploymentId, host: { ...host, submit: async () => assert.fail('Retry must skip the Agent') } }
    },
  }
}

test('retries build and scene validation with retained changes after reopening the Host', async t => {
  for (const legacy of [false, true]) {
    await t.test(legacy ? 'legacy stored failure without a candidate manifest' : 'stored candidate manifest', async t => {
      const failed = await failedBuild(t)
      if (legacy) {
        const state = JSON.parse(await readFile(failed.stateFile, 'utf8'))
        delete state.candidateFiles
        delete state.view.canRetryBuild
        delete state.view.sourceDeploymentId
        await writeFile(failed.stateFile, JSON.stringify(state))
      }
      const jobs = failed.reopen()
      assert.equal((await jobs.status(failed.projectRoot))?.canRetryBuild, true)
      const { sourceDeploymentId, host } = failed.prepareRetry()
      const accepted = await jobs.submit(failed.retry, host)
      assert.equal(accepted.sourceDeploymentId, sourceDeploymentId)
      await jobs.drain()
      const applied = await jobs.status(failed.projectRoot)
      assert.equal(applied?.phase, 'applied', applied?.log)
      assert.equal(applied.project?.activeRole, 'candidate')
      assert.equal(await readFile(join(failed.projectRoot, 'app.txt'), 'utf8'), 'Candidate source')
      assert.equal((await jobs.submit(failed.retry, host)).phase, 'applied')
    })
  }
})

test('rejects a stale retry ID and requires an Agent review if retained source changed', async t => {
  const failed = await failedBuild(t)
  const jobs = failed.reopen()
  const { host } = failed.prepareRetry()
  await assert.rejects(jobs.submit({ ...failed.retry, retryOf: randomUUID() }, host), IterationAdmissionError)
  await writeFile(join(failed.candidateRoot, 'app.txt'), 'Changed after validation')
  await jobs.submit(failed.retry, host)
  await jobs.drain()
  const view = await jobs.status(failed.projectRoot)
  assert.equal(view?.phase, 'failed')
  assert.equal(view.canRetryBuild, false)
  assert.match(view.detail, /retained candidate changed/)
  assert.equal(await readFile(join(failed.projectRoot, 'app.txt'), 'utf8'), 'Live source')
})

test('keeps an iteration unsubmitted until the other Android device is ready', async t => {
  const failed = await failedBuild(t)
  const jobs = failed.reopen()
  const { host } = failed.prepareRetry()
  const pendingHost = {
    ...host,
    manager: { currentEndpoint: () => ({ devices: [{ id: 'live' }] }) } as Execution['manager'],
  }
  await assert.rejects(jobs.submit(failed.retry, pendingHost), /background Android device must be ready/)
  await jobs.submit(failed.retry, host)
  await jobs.drain()
  assert.equal((await jobs.submit(failed.retry, pendingHost)).phase, 'applied')
})
