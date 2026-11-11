import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AndroidRuntimeManager, type RuntimeProcessRunner } from '../src/runtime/manager.ts';

const assets = ['bootstrap.sh', 'sdk-metadata.sh', 'install-gateway.sh', 'start.sh', 'gateway.py', 'gpu_probe.py', 'android_scene.py',
  'rtc-allowlist.json', 'build-tools.sh', 'build-tools-lock.json', 'react-native.init.gradle'];
const rootfsName = 'ubuntu-base-24.04.5-base-amd64.tar.gz';
const rootfs = 'pinned root filesystem fixture';
const lock = {
  wsl: {
    rootfs: rootfsName,
    rootfsSha256: createHash('sha256').update(rootfs).digest('hex'),
  },
};

const ready = {
  event: 'ready',
  gatewayUrl: 'http://127.0.0.1:34567',
  token: 'not-a-real-token'.repeat(3),
  devices: [
    { id: 'live', width: 720, height: 1280 },
    { id: 'candidate', width: 720, height: 1280 },
  ],
};
const deployed = {
  deploymentId: randomUUID(), activeRole: 'candidate', projectRoot: 'C:/AppStudio/Project',
  framework: 'flutter', applicationId: 'dev.appstudio.test', versionCode: '1', restored: true,
};

async function fixture(t: TestContext, idleTimeoutMs?: number) {
  const base = await mkdtemp(join(tmpdir(), 'appstudio-runtime-test-'));
  const dataDir = join(base, 'data');
  const assetDir = join(base, 'assets');
  await mkdir(dataDir);
  await mkdir(assetDir);
  await writeFile(join(dataDir, rootfsName), rootfs);
  await writeFile(join(assetDir, 'runtime-lock.json'), JSON.stringify(lock));
  await Promise.all(assets.map(name => writeFile(join(assetDir, name), 'asset ' + name)));
  t.after(() => rm(base, { recursive: true, force: true }));

  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const controls = {
    owner: '', stdout: JSON.stringify(ready) + '\n',
    background: undefined as Promise<string> | undefined, exitCode: undefined as number | undefined,
    preflightError: '', distroMissing: false, stderr: '',
  };
  const runner: RuntimeProcessRunner = {
    async run(command, args, options) {
      assert.equal(command, 'wsl.exe');
      calls.push({ args, input: options?.input });
      if (args.includes('appstudio-owner')) controls.owner = args.at(-1)!;
      if (args[0] === '--status' && controls.preflightError) return { code: 1, stderr: controls.preflightError, stdout: '' };
      if (args.includes('/bin/cat') && controls.distroMissing) return { code: 1, stderr: 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND', stdout: '' };
      return {
        code: 0,
        stdout: args.includes('/bin/cat') ? controls.owner + '\n' : '',
        stderr: '',
      };
    },
    async spawn(command, args) {
      assert.equal(command, 'wsl.exe');
      calls.push({ args });
      const completion = Promise.withResolvers<{ code: number }>();
      if (controls.exitCode !== undefined) completion.resolve({ code: controls.exitCode });
      return {
        stdout: (async function* () {
          yield controls.stdout;
          if (controls.background) yield await controls.background;
        })(),
        stderr: (async function* () { yield controls.stderr; })(),
        completion: completion.promise,
        async stop() { completion.resolve({ code: 0 }); },
      };
    },
  };
  const options = { dataDir, assetDir, runner, platform: 'win32' as const, architecture: 'x64', idleTimeoutMs };
  return { manager: new AndroidRuntimeManager(options), options, calls, controls };
}

test('provisions a persistent WSL2 distribution with consent and a pinned root filesystem', async t => {
  const { manager, options, calls } = await fixture(t);
  assert.equal((await manager.status()).phase, 'unconfigured');
  await assert.rejects(manager.prepare(false), /Accept the Android SDK license/);
  assert.deepEqual(calls.map(call => call.args), [['--status']]);

  assert.equal((await manager.prepare(true)).phase, 'stopped');
  const importCall = calls.find(call => call.args[0] === '--import');
  assert.match(importCall!.args[1]!, /^DSH-AppStudio-/);
  assert.equal(importCall!.args[3], join(options.dataDir, rootfsName));
  assert.deepEqual(importCall!.args.slice(4), ['--version', '2']);
  assert.equal(calls.find(call => call.args.at(-1)?.endsWith('/bootstrap.sh'))?.input, 'asset bootstrap.sh');
  assert.equal(calls.at(-1)?.args[0], '--terminate');

  const restarted = new AndroidRuntimeManager(options);
  assert.equal((await restarted.status()).phase, 'stopped');
  const count = calls.length;
  await restarted.prepare(true);
  assert.equal(calls.length, count);
});

test('reports host prerequisites before import and retries after WSL becomes available', async t => {
  const { manager, options, calls, controls } = await fixture(t);
  const arm = new AndroidRuntimeManager({ ...options, architecture: 'arm64' });
  assert.equal((await arm.status()).issue, 'host-architecture');
  assert.equal(calls.length, 0);
  controls.preflightError = 'Wsl/Service/CreateInstance/HCS/HCS_E_HYPERV_NOT_INSTALLED';
  const status = await manager.status();
  assert.equal(status.issue, 'wsl-virtualization');
  assert.equal(status.configured, false);
  await assert.rejects(manager.prepare(true), /Cannot use WSL2/);
  assert.equal(calls.some(call => call.args[0] === '--import'), false);
  controls.preflightError = '';
  assert.equal((await manager.prepare(true)).configured, true);
});

test('reinitializes when its recorded distribution was removed externally', async t => {
  const { manager, calls, controls } = await fixture(t);
  await manager.prepare(true);
  const oldOwner = controls.owner;
  controls.distroMissing = true;
  await assert.rejects(manager.start(), /WSL_E_DISTRO_NOT_FOUND/);
  assert.equal((await manager.status()).issue, 'runtime-missing');
  await manager.uninstall();
  assert.equal(calls.some(call => call.args[0] === '--unregister'), false);
  controls.distroMissing = false;
  await manager.prepare(true);
  assert.notEqual(controls.owner, oldOwner);
});

test('validates the authenticated Windows loopback before exposing Live', async t => {
  const { manager, controls } = await fixture(t);
  await manager.prepare(true);
  controls.stdout = JSON.stringify({ ...ready, healthCheck: true }) + '\n';
  let available = false;
  let refuseOnce = true;
  const health = t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(url.href, ready.gatewayUrl + '/v1/health');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + ready.token);
    if (available && refuseOnce) {
      refuseOnce = false;
      throw new TypeError('connect failed', { cause: { code: 'ECONNREFUSED' } });
    }
    return new Response(null, { status: available ? 204 : 401 });
  });
  await assert.rejects(manager.start(), /Windows cannot reach/);
  assert.equal(manager.currentEndpoint(), undefined);
  assert.equal((await manager.status()).issue, 'gateway-loopback');
  assert.equal(health.mock.callCount(), 1);
  available = true;
  await manager.start();
  assert.equal(health.mock.callCount(), 3);
  assert.equal((await manager.status()).phase, 'running');
  assert.equal(JSON.stringify(await manager.status()).includes(ready.token), false);
  await manager.dispose();
});

test('shows guest startup diagnostics and redacts credentials', async t => {
  const { manager, controls } = await fixture(t);
  await manager.prepare(true);
  controls.stdout = '';
  controls.exitCode = 1;
  controls.stderr = 'APPSTUDIO_RUNTIME_ERROR kvm-unavailable\nKVM failed. Authorization: Bearer ' + ready.token;
  await assert.rejects(manager.start(), /KVM failed/);
  const status = await manager.status();
  assert.equal(status.issue, 'kvm-unavailable');
  assert.equal(status.configured, true);
  assert.equal(status.detail.includes(ready.token), false);
});

test('repairs a damaged SDK in the existing owned distribution', async t => {
  const { manager, calls, controls } = await fixture(t);
  await manager.prepare(true);
  const count = calls.length;
  const owner = controls.owner;
  controls.stdout = '';
  controls.exitCode = 1;
  controls.stderr = 'APPSTUDIO_RUNTIME_ERROR sdk-invalid\nSDK files are missing.';
  await assert.rejects(manager.start(), /SDK files are missing/);
  assert.equal((await manager.status()).issue, 'sdk-invalid');
  await manager.prepare(true);
  assert.equal((await manager.status()).phase, 'stopped');
  assert.equal(controls.owner, owner);
  assert.equal(calls.slice(count).filter(call => call.args.at(-2)?.endsWith('/bootstrap.sh')).length, 1);
  assert.equal(calls.slice(count).some(call => ['--import', '--unregister'].includes(call.args[0]!)), false);
});

test('refuses to unregister a distribution without matching Linux ownership', async t => {
  const { manager, options, calls, controls } = await fixture(t);
  await manager.prepare(true);
  controls.owner = 'another-profile';
  await assert.rejects(manager.uninstall(), /does not belong to this App Studio profile/);
  assert.equal(calls.some(call => call.args[0] === '--unregister'), false);
  assert.ok(await readFile(join(options.dataDir, 'owner.json'), 'utf8'));
});

test('keeps Gateway credentials in the Host and stops only the claimed runtime', async t => {
  const { manager, calls } = await fixture(t);
  await manager.prepare(true);
  assert.deepEqual(await manager.start(), {
    gatewayUrl: ready.gatewayUrl,
    token: ready.token,
    devices: ready.devices,
  });
  assert.equal(manager.currentEndpoint()?.token, ready.token);
  assert.equal(JSON.stringify(await manager.status()).includes(ready.token), false);

  await manager.dispose();
  assert.equal(manager.currentEndpoint(), undefined);
  assert.equal(calls.at(-2)?.args.includes('--stop'), true);
  assert.equal(calls.at(-1)?.args[0], '--terminate');
});

test('does not stop a competing supervisor when the gateway claim was refused', async t => {
  const { manager, calls, controls } = await fixture(t);
  await manager.prepare(true);
  const count = calls.length;
  controls.stdout = '';
  controls.exitCode = 75;
  await assert.rejects(manager.start(), /Android Runtime exited \(75\)/);
  assert.equal(calls.slice(count).some(call => call.args[0] === '--terminate' || call.args.includes('--stop')), false);
  assert.equal(manager.currentEndpoint(), undefined);
});

test('rejects a non-loopback Gateway endpoint and releases its claimed runtime', async t => {
  const { manager, calls, controls } = await fixture(t);
  await manager.prepare(true);
  controls.stdout = JSON.stringify({ event: 'starting' }) + '\n' +
    JSON.stringify({ ...ready, gatewayUrl: 'http://0.0.0.0:34567' }) + '\n';
  await assert.rejects(manager.start(), /did not return a valid startup message\. The loopback endpoint is invalid\./);
  assert.equal(manager.currentEndpoint(), undefined);
  assert.equal(calls.at(-2)?.args.includes('--stop'), true);
  assert.equal(calls.at(-1)?.args[0], '--terminate');
});

test('publishes the saved active device first and adds the background device to the same endpoint', async t => {
  const { manager, options, calls, controls } = await fixture(t);
  await manager.prepare(true);
  await writeFile(join(options.dataDir, 'active-project.json'), JSON.stringify({
    ownerId: controls.owner, project: deployed,
  }));
  const background = Promise.withResolvers<string>();
  controls.stdout = JSON.stringify({ ...ready, devices: [ready.devices[1]] }) + '\n';
  controls.background = background.promise;
  const endpoint = await manager.start({ deferBackground: true });
  const signal = new AbortController().signal;
  assert.deepEqual(calls.at(-1)?.args.slice(-2), ['candidate', 'after-preview']);
  assert.equal((await manager.status()).background, 'starting');
  assert.equal((await manager.status()).resumeExpected, true);
  assert.deepEqual((await manager.status()).devices, [ready.devices[1]]);
  const demand = t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    assert.equal(input.href, ready.gatewayUrl + '/v1/background/start');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + ready.token);
    assert.ok(init.signal);
    return new Response(null, { status: 204 });
  });
  await manager.waitForDevice(endpoint, 'candidate', signal);
  assert.equal(demand.mock.callCount(), 0);
  let backgroundReady = false;
  const waiting = manager.waitForDevice(endpoint, 'live', signal).then(() => { backgroundReady = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(backgroundReady, false);
  assert.equal(demand.mock.callCount(), 1);
  background.resolve(JSON.stringify({ event: 'device-ready', device: ready.devices[0] }) + '\n');
  await waiting;
  assert.equal(manager.currentEndpoint(), endpoint);
  assert.equal((await manager.status()).background, undefined);
  assert.deepEqual((await manager.status()).devices, [ready.devices[1], ready.devices[0]]);
  await manager.dispose();
});

test('foreign deployment records do not select the first device and background failure keeps Live available', async t => {
  const { manager, options, calls, controls } = await fixture(t);
  await manager.prepare(true);
  await writeFile(join(options.dataDir, 'active-project.json'), JSON.stringify({
    ownerId: randomUUID(), project: deployed,
  }));
  const background = Promise.withResolvers<string>();
  controls.stdout = JSON.stringify({ ...ready, devices: [ready.devices[0]] }) + '\n';
  controls.background = background.promise;
  const endpoint = await manager.start();
  assert.equal(calls.at(-1)?.args.at(-1), 'live');
  assert.equal((await manager.status()).resumeExpected, undefined);
  const signal = new AbortController().signal;
  const unavailable = assert.rejects(manager.waitForDevice(endpoint, 'candidate', signal), /background Android device could not start/);
  background.resolve(JSON.stringify({ event: 'device-error', role: 'candidate', code: 'guest-resources', detail: 'Insufficient guest memory.' }) + '\n');
  await unavailable;
  assert.equal(manager.currentEndpoint(), endpoint);
  assert.equal((await manager.status()).phase, 'running');
  assert.equal((await manager.status()).background, 'failed');
  assert.equal((await manager.status()).issue, 'guest-resources');
  assert.match((await manager.status()).detail, /Insufficient guest memory/);
  await manager.waitForDevice(endpoint, 'live', signal);
  await manager.dispose();
});

test('request cancellation and runtime stop release a background-device wait', async t => {
  const { manager, controls } = await fixture(t);
  await manager.prepare(true);
  const background = Promise.withResolvers<string>();
  controls.stdout = JSON.stringify({ ...ready, devices: [ready.devices[0]] }) + '\n';
  controls.background = background.promise;
  const endpoint = await manager.start();
  const request = new AbortController();
  const canceled = assert.rejects(manager.waitForDevice(endpoint, 'candidate', request.signal), { name: 'AbortError' });
  request.abort();
  await canceled;
  assert.equal(manager.currentEndpoint(), endpoint);

  const stopped = assert.rejects(manager.waitForDevice(endpoint, 'candidate', new AbortController().signal), { name: 'AbortError' });
  await manager.stop();
  await stopped;
  background.resolve(JSON.stringify({ event: 'device-ready', device: ready.devices[1] }) + '\n');
  assert.equal(manager.currentEndpoint(), undefined);
  assert.equal((await manager.status()).phase, 'stopped');
});

test('a failed background-start request can be retried on the same live endpoint', async t => {
  const { manager, controls } = await fixture(t);
  await manager.prepare(true);
  const background = Promise.withResolvers<string>();
  controls.stdout = JSON.stringify({ ...ready, devices: [ready.devices[0]] }) + '\n';
  controls.background = background.promise;
  const endpoint = await manager.start({ deferBackground: true });
  const demand = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  const signal = new AbortController().signal;
  await assert.rejects(manager.waitForDevice(endpoint, 'candidate', signal), /Could not request startup/);
  assert.equal(manager.currentEndpoint(), endpoint);
  assert.equal((await manager.status()).background, 'starting');

  demand.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  const waiting = manager.waitForDevice(endpoint, 'candidate', signal);
  background.resolve(JSON.stringify({ event: 'device-ready', device: ready.devices[1] }) + '\n');
  await waiting;
  assert.equal(demand.mock.callCount(), 2);
  assert.equal(manager.currentEndpoint(), endpoint);
  await manager.dispose();
});

test('idle shutdown waits for all Live users and rechecks usage when its timer fires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, calls } = await fixture(t, 20);
  await manager.prepare(true);
  assert.throws(() => manager.acquireUse(), /Start the Android Runtime/);
  await manager.start();

  t.mock.timers.tick(20);
  const releaseFirst = manager.acquireUse();
  const releaseLast = manager.acquireUse();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await manager.status()).phase, 'running');

  releaseFirst();
  releaseFirst();
  t.mock.timers.tick(20);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await manager.status()).phase, 'running');

  releaseLast();
  t.mock.timers.tick(19);
  assert.equal((await manager.status()).phase, 'running');
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await manager.status()).phase, 'stopped');
  assert.equal(calls.at(-2)?.args.includes('--stop'), true);
  assert.equal(calls.at(-1)?.args[0], '--terminate');
});

test('a release from a stopped runtime leaves the next runtime idle timer intact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager } = await fixture(t, 20);
  await manager.prepare(true);
  const oldEndpoint = await manager.start();
  const oldSignal = manager.endpointSignal(oldEndpoint);
  const releaseOld = manager.acquireUse();
  await manager.stop();
  assert.equal(oldSignal.aborted, true);

  const newEndpoint = await manager.start();
  assert.equal(manager.endpointSignal(newEndpoint).aborted, false);
  assert.throws(() => manager.endpointSignal(oldEndpoint), /runtime stopped/);
  t.mock.timers.tick(10);
  releaseOld();
  t.mock.timers.tick(10);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await manager.status()).phase, 'stopped');
});
