import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AndroidRuntimeManager, type RuntimeProcessRunner } from '../src/runtime/manager.ts';

const assets = ['bootstrap.sh', 'install-gateway.sh', 'start.sh', 'gateway.py', 'android_scene.py',
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
  const controls = { owner: '', stdout: JSON.stringify(ready) + '\n', exitCode: undefined as number | undefined };
  const runner: RuntimeProcessRunner = {
    async run(command, args, options) {
      assert.equal(command, 'wsl.exe');
      calls.push({ args, input: options?.input });
      if (args.includes('appstudio-owner')) controls.owner = args.at(-1)!;
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
        stdout: (async function* () { yield controls.stdout; })(),
        stderr: (async function* () {})(),
        completion: completion.promise,
        async stop() { completion.resolve({ code: 0 }); },
      };
    },
  };
  const options = { dataDir, assetDir, runner, platform: 'win32' as const, idleTimeoutMs };
  return { manager: new AndroidRuntimeManager(options), options, calls, controls };
}

test('provisions a persistent WSL2 distribution with consent and a pinned root filesystem', async t => {
  const { manager, options, calls } = await fixture(t);
  assert.equal((await manager.status()).phase, 'unconfigured');
  await assert.rejects(manager.prepare(false), /Accept the Android SDK license/);
  assert.equal(calls.length, 0);

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
  await assert.rejects(manager.start(), /did not return a valid startup message/);
  assert.equal(manager.currentEndpoint(), undefined);
  assert.equal(calls.at(-2)?.args.includes('--stop'), true);
  assert.equal(calls.at(-1)?.args[0], '--terminate');
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
  await manager.start();
  const releaseOld = manager.acquireUse();
  await manager.stop();

  await manager.start();
  t.mock.timers.tick(10);
  releaseOld();
  t.mock.timers.tick(10);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await manager.status()).phase, 'stopped');
});
