import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { FrameworkCapability } from '../src/project/frameworks.ts'
import { ProjectRun } from '../src/project/run.ts'
import type { AndroidRuntimeManager, RuntimeEndpoint } from '../src/runtime/manager.ts'
import type { ProjectView } from '../src/shared/protocol.ts'

const applicationId = 'dev.appstudio.test'
const checkpoint = { pid: 412, versionCode: '1', scene: { route: 'stats' } }

async function fixture(t: TestContext) {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'appstudio-project-run-')))
  t.after(() => rm(projectRoot, { recursive: true, force: true }))
  await writeFile(join(projectRoot, 'pubspec.yaml'), 'name: fixture\n')
  const recordPath = join(projectRoot, 'state', 'active-project.json')
  const ownerId = randomUUID()
  const endpoint: RuntimeEndpoint = {
    gatewayUrl: 'http://127.0.0.1:65001', token: 'fixture-token',
    devices: [{ id: 'live', width: 720, height: 1280 }, { id: 'candidate', width: 720, height: 1280 }],
  }
  const manager = {
    currentEndpoint: () => endpoint,
    activeOwner: (current: RuntimeEndpoint) => current === endpoint ? ownerId : undefined,
    start: async () => endpoint,
    waitForDevice: async () => {},
    acquireUse: () => () => {},
    prepareBuildTools: async () => '',
    runProjectCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  } as unknown as AndroidRuntimeManager
  return { projectRoot, recordPath, ownerId, manager, endpoint }
}

test('remembers a deployed project and restores it on a new Host without building', { skip: process.platform !== 'win32' }, async t => {
  const { projectRoot, recordPath, ownerId, manager } = await fixture(t)
  const signal = new AbortController().signal
  const build = t.mock.fn(async () => ({ apkPath: '/staged/app.apk', applicationId, launchActivity: '.MainActivity', versionCode: 1 }))
  const adapter: FrameworkCapability = { signal, build }
  const request = t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    assert.equal(input.pathname, '/v1/devices/live/deploy')
    assert.equal(JSON.parse(String(init.body)).applicationId, applicationId)
    return Response.json({ pid: checkpoint.pid, previousPid: null, sceneRestored: false, checkpoint })
  })
  let deployed: ProjectView | undefined
  for await (const event of new ProjectRun(recordPath).execute(manager, adapter, { projectRoot, framework: 'flutter' }, false, signal)) {
    if (event.kind === 'error') assert.fail(event.text)
    if (event.kind === 'ready') deployed = event.project
  }
  assert(deployed)
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), { ownerId, project: deployed })

  request.mock.mockImplementation(async (input: URL, init: RequestInit) => {
    assert.equal(input.pathname, '/v1/devices/live/resume')
    assert.deepEqual(JSON.parse(String(init.body)), { applicationId, versionCode: '1' })
    return Response.json(checkpoint)
  })
  const reopened = new ProjectRun(recordPath)
  assert.equal(reopened.status(manager).framework, null)
  const recovered = await Promise.all([reopened.restore(manager, signal), reopened.restore(manager, signal)])
  assert.deepEqual(recovered, [deployed, deployed])
  assert.deepEqual(reopened.status(manager), deployed)
  assert.equal(request.mock.callCount(), 2)
  assert.equal(build.mock.callCount(), 1)
})

test('migrates only a verified legacy deployment in the current runtime', { skip: process.platform !== 'win32' }, async t => {
  const { projectRoot, recordPath, ownerId, manager } = await fixture(t)
  const signal = new AbortController().signal
  const legacy: ProjectView = {
    projectRoot, activeRole: 'candidate', deploymentId: randomUUID(), framework: 'flutter',
    applicationId, versionCode: '1', restored: false,
  }
  const request = t.mock.method(globalThis, 'fetch', async (input: URL) => {
    assert.equal(input.pathname, '/v1/devices/candidate/resume')
    return Response.json({ ...checkpoint, versionCode: '2' })
  })
  const reopened = new ProjectRun(recordPath)
  assert.equal((await reopened.restore(manager, signal, legacy)).framework, null)
  await assert.rejects(readFile(recordPath), { code: 'ENOENT' })

  request.mock.mockImplementation(async () => Response.json(checkpoint))
  assert.deepEqual(await reopened.restore(manager, signal, legacy), legacy)
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), { ownerId, project: legacy })

  const otherRuntime = { currentEndpoint: () => manager.currentEndpoint(), activeOwner: () => randomUUID() } as unknown as AndroidRuntimeManager
  assert.equal((await new ProjectRun(recordPath).restore(otherRuntime, signal, legacy)).framework, null)
  assert.equal(request.mock.callCount(), 2)
})

test('waits for the target before capturing the scene and keeps Live when validation fails', { skip: process.platform !== 'win32' }, async t => {
  const { projectRoot, recordPath, ownerId, manager, endpoint } = await fixture(t)
  const signal = new AbortController().signal
  const current: ProjectView = {
    projectRoot, activeRole: 'candidate', deploymentId: randomUUID(), framework: 'flutter',
    applicationId, versionCode: '1', restored: false,
  }
  const start = t.mock.method(manager, 'start')
  const promote = t.mock.fn(async () => {})
  const requests: string[] = []
  const detail = 'The app did not restore the captured scene in its new process.'
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    requests.push(input.pathname)
    if (input.pathname === '/v1/devices/live/deploy') {
      assert.deepEqual(JSON.parse(String(init.body)).checkpoint, checkpoint)
      return Response.json({ error: detail }, { status: 422 })
    }
    assert.match(input.pathname, /^\/v1\/devices\/candidate\/(resume|capture)$/u)
    return Response.json(checkpoint)
  })
  const project = new ProjectRun(recordPath)
  assert.deepEqual(await project.restore(manager, signal, current), current)
  const target = endpoint.devices.shift()
  assert.equal(target?.id, 'live')
  const waiting = Promise.withResolvers<void>()
  const booted = Promise.withResolvers<void>()
  t.mock.method(manager, 'waitForDevice', async (held: RuntimeEndpoint, role: string) => {
    assert.equal(held, endpoint)
    assert.equal(role, 'live')
    waiting.resolve()
    await booted.promise
  })
  const adapter: FrameworkCapability = {
    signal, build: async () => ({ apkPath: '/staged/app.apk', applicationId, launchActivity: '.MainActivity', versionCode: 1 }),
  }
  const rebuilding = Array.fromAsync(project.execute(manager, adapter, { projectRoot, framework: 'flutter' }, true, signal, {
    sourceRoot: projectRoot, onValidation: async () => {}, beforePromote: promote,
  }))
  await waiting.promise
  assert.deepEqual(requests, ['/v1/devices/candidate/resume'])
  assert.deepEqual(project.status(manager), current)
  endpoint.devices.push(target!)
  booted.resolve()
  const events = await rebuilding
  assert.deepEqual(events.at(-1), { kind: 'error', text: detail })
  assert.deepEqual(requests, ['/v1/devices/candidate/resume', '/v1/devices/candidate/capture', '/v1/devices/live/deploy'])
  assert.equal(start.mock.callCount(), 0)
  assert.equal(promote.mock.callCount(), 0)
  assert.deepEqual(project.status(manager), current)
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), { ownerId, project: current })
})
