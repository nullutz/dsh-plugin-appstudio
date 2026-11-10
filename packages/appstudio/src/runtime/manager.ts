import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrameworkId } from '../shared/protocol.ts';

export interface RuntimeProcessOptions {
  input?: string;
  inputStream?: AsyncIterable<Uint8Array>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RuntimeChild {
  stdout: AsyncIterable<string | Uint8Array>;
  stderr: AsyncIterable<string | Uint8Array>;
  completion: Promise<{ code: number | null }>;
  stop(): Promise<void>;
}

export interface RuntimeProcessRunner {
  run(command: string, args: readonly string[], options?: RuntimeProcessOptions): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>;
  spawn(command: string, args: readonly string[], options?: RuntimeProcessOptions): Promise<RuntimeChild>;
}

export interface RuntimeDevice {
  id: 'live' | 'candidate';
  width: number;
  height: number;
}

/** Host-only credentials for the loopback Gateway. */
export interface RuntimeEndpoint {
  gatewayUrl: string;
  token: string;
  devices: RuntimeDevice[];
}

export interface RuntimeStatus {
  phase: 'unsupported' | 'unconfigured' | 'preparing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  detail: string;
  devices: RuntimeDevice[];
}

export interface RuntimeManagerOptions {
  /** An absolute, profile-owned Windows storage directory. */
  dataDir: string;
  assetDir: string;
  runner: RuntimeProcessRunner;
  platform?: NodeJS.Platform;
  idleTimeoutMs?: number;
}

interface Owner {
  ownerId: string;
  imported: boolean;
  lockHash?: string;
}

interface ActiveRuntime {
  owner: Owner;
  child: RuntimeChild;
  claimed: boolean;
  uses: number;
  lifetime: AbortController;
  idleTimer?: ReturnType<typeof setTimeout>;
  endpoint?: RuntimeEndpoint;
}

const WSL = 'wsl.exe';
const HOME = '/opt/appstudio';
const ASSET_DIR = HOME + '/runtime';
const ASSETS = ['runtime-lock.json', 'bootstrap.sh', 'install-gateway.sh', 'start.sh', 'gateway.py', 'android_scene.py',
  'rtc-allowlist.json', 'build-tools.sh', 'build-tools-lock.json', 'react-native.init.gradle'];
const WSL_TIMEOUT = 30_000;
const START_TIMEOUT = 6 * 60_000;
const IDLE_TIMEOUT = 30_000;
const INSTALL_TIMEOUT = 30 * 60_000;
const ROOTFS_LIMIT = 96 * 1024 * 1024;
const ROOTFS_ORIGIN = 'https://cdimages.ubuntu.com/ubuntu-base/releases/24.04/release/';

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function ownerFromJson(json: string): Owner {
  const value = asRecord(JSON.parse(json));
  if (
    typeof value?.ownerId !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value.ownerId) ||
    typeof value.imported !== 'boolean' ||
    (value.lockHash !== undefined &&
      (!value.imported || typeof value.lockHash !== 'string' || !/^[\da-f]{64}$/.test(value.lockHash)))
  ) throw new Error('App Studio runtime ownership record is invalid.');
  return { ownerId: value.ownerId, imported: value.imported, lockHash: value.lockHash };
}

function endpointFromJson(value: unknown): RuntimeEndpoint | undefined {
  const record = asRecord(value);
  if (record?.event !== 'ready') return undefined;
  const { gatewayUrl, token, devices } = record;
  if (typeof gatewayUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(gatewayUrl) ||
      typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token) || !Array.isArray(devices)) {
    throw new Error('App Studio Gateway returned an invalid endpoint.');
  }
  const url = new URL(gatewayUrl);
  if (!url.port || Number(url.port) === 0) throw new Error('App Studio Gateway returned an invalid port.');
  const mapped: RuntimeDevice[] = devices.map((entry: unknown) => {
    const device = asRecord(entry);
    const id = device?.id;
    const width = device?.width;
    const height = device?.height;
    if ((id !== 'live' && id !== 'candidate') || typeof width !== 'number' || typeof height !== 'number' ||
        !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > 8192 || height > 8192) throw new Error('App Studio Gateway returned invalid device dimensions.');
    return { id, width, height };
  });
  if (mapped.length !== 2 || new Set(mapped.map(device => device.id)).size !== 2) {
    throw new Error('App Studio Gateway did not return both owned devices.');
  }
  return { gatewayUrl: url.origin, token, devices: mapped };
}

/** Consume the supervisor's machine output without logging its credentials. */
async function readEndpoint(
  stdout: RuntimeChild['stdout'],
  claimed: () => void,
  ready: (value: RuntimeEndpoint) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  let announced = false;
  for await (const chunk of stdout) {
    if (announced) continue;
    buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    while (buffered.includes('\n')) {
      const line = buffered.slice(0, buffered.indexOf('\n')).trim();
      buffered = buffered.slice(buffered.indexOf('\n') + 1);
      if (!line.startsWith('{')) continue;
      const message = asRecord(JSON.parse(line));
      if (message?.event === 'starting') claimed();
      const endpoint = endpointFromJson(message);
      if (endpoint) {
        announced = true;
        claimed();
        ready(endpoint);
        break;
      }
    }
    if (!announced && buffered.length > 8192) throw new Error('Invalid App Studio Gateway startup output.');
  }
}

/** Owns the Android distribution and its two-device process for one DSH profile. */
export class AndroidRuntimeManager {
  readonly #options: RuntimeManagerOptions;
  readonly #supported: boolean;
  readonly #lifetime = new AbortController();
  #tail: Promise<void> = Promise.resolve();
  #phase: RuntimeStatus['phase'] | undefined;
  #detail = '';
  #running: ActiveRuntime | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: RuntimeManagerOptions) {
    this.#options = options;
    this.#supported = (options.platform ?? process.platform) === 'win32';
  }

  async status(): Promise<RuntimeStatus> {
    if (!this.#supported) return { phase: 'unsupported', detail: 'Android Runtime requires Windows and WSL2.', devices: [] };
    if (this.#phase) {
      return { phase: this.#phase, detail: this.#detail, devices: this.#running?.endpoint?.devices.map(device => ({ ...device })) ?? [] };
    }
    try {
      const owner = await this.#readOwner();
      if (owner?.lockHash) {
        if (owner.lockHash !== sha256(await this.#asset('runtime-lock.json'))) {
          return { phase: 'error', detail: 'The runtime version changed. Reinitialize the environment.', devices: [] };
        }
        return { phase: 'stopped', detail: 'Android Runtime is configured.', devices: [] };
      }
      return { phase: 'unconfigured', detail: 'Prepare the dedicated Android Runtime to continue.', devices: [] };
    } catch (error) {
      return { phase: 'error', detail: errorText(error), devices: [] };
    }
  }

  currentEndpoint(): RuntimeEndpoint | undefined {
    if (this.#phase === 'running' && !this.#disposed) return this.#running?.endpoint;
    return undefined;
  }

  runProjectCommand(endpoint: RuntimeEndpoint, argv: readonly string[], options?: RuntimeProcessOptions): ReturnType<RuntimeProcessRunner['run']> {
    const active = this.#activeProjectRuntime(endpoint);
    return this.#options.runner.run(WSL, ['-d', this.#name(active.owner), '-u', 'appstudio', '--cd', '/', '--exec', ...argv], {
      ...options,
      signal: AbortSignal.any([active.lifetime.signal, ...(options?.signal ? [options.signal] : [])]),
    });
  }

  async prepareBuildTools(endpoint: RuntimeEndpoint, framework: FrameworkId, signal: AbortSignal): Promise<string> {
    const active = this.#activeProjectRuntime(endpoint);
    const output = await this.#wsl(this.#inside(active.owner, ['/bin/bash', ASSET_DIR + '/build-tools.sh', active.owner.ownerId, framework]),
      'Cannot prepare the Android build tools.', {
        timeoutMs: INSTALL_TIMEOUT,
        signal: AbortSignal.any([active.lifetime.signal, signal]),
      });
    return output;
  }

  #activeProjectRuntime(endpoint: RuntimeEndpoint): ActiveRuntime {
    const active = this.#running;
    if (!active || this.currentEndpoint() !== endpoint) throw new Error('The Android runtime stopped during the project run.');
    return active;
  }

  acquireUse(): () => void {
    const active = this.#running;
    if (!active || !this.currentEndpoint()) throw new Error('Start the Android Runtime before connecting Live.');
    this.#clearIdle(active);
    active.uses++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#running !== active || !this.currentEndpoint()) return;
      active.uses--;
      if (active.uses === 0) this.#armIdle(active);
    };
  }

  prepare(licenseAccepted: boolean): Promise<RuntimeStatus> {
    return this.#operate(() => this.#prepare(licenseAccepted));
  }

  start(): Promise<RuntimeEndpoint> {
    return this.#operate(() => this.#start());
  }

  stop(): Promise<RuntimeStatus> {
    return this.#operate(() => this.#stop());
  }

  uninstall(): Promise<RuntimeStatus> {
    return this.#operate(() => this.#uninstall());
  }

  reinitialize(licenseAccepted: boolean): Promise<RuntimeStatus> {
    return this.#operate(async () => {
      this.#requireLicense(licenseAccepted);
      await this.#uninstall();
      return this.#prepare(licenseAccepted);
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    if (this.#running) this.#clearIdle(this.#running);
    this.#lifetime.abort();
    this.#disposePromise = this.#tail.then(async () => {
      if (this.#running) await this.#stop();
    });
    return this.#disposePromise;
  }

  #operate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (!this.#supported) throw new Error('Android Runtime requires Windows and WSL2.');
      if (this.#disposed) throw new Error('App Studio runtime manager has been disposed.');
      try {
        return await operation();
      } catch (error) {
        this.#set('error', errorText(error));
        throw error;
      }
    });
    this.#tail = result.then(() => {}, () => {});
    return result;
  }

  #set(phase: RuntimeStatus['phase'], detail: string): void {
    this.#phase = phase;
    this.#detail = detail;
  }

  #clearIdle(active: ActiveRuntime): void {
    clearTimeout(active.idleTimer);
    active.idleTimer = undefined;
  }

  #armIdle(active: ActiveRuntime): void {
    this.#clearIdle(active);
    const timer = setTimeout(() => {
      void this.#operate(async () => {
        if (this.#running === active && active.idleTimer === timer && active.uses === 0 && this.currentEndpoint()) {
          await this.#stop();
        }
      }).catch(() => {});
    }, this.#options.idleTimeoutMs ?? IDLE_TIMEOUT);
    timer.unref();
    active.idleTimer = timer;
  }

  get #ownerFile(): string {
    return join(this.#options.dataDir, 'owner.json');
  }

  async #readOwner(): Promise<Owner | undefined> {
    try {
      return ownerFromJson(await readFile(this.#ownerFile, 'utf8'));
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async #saveOwner(owner: Owner): Promise<void> {
    const temporary = this.#ownerFile + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(owner) + '\n', { flag: 'wx' });
      await rename(temporary, this.#ownerFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #name(owner: Owner): string {
    return 'DSH-AppStudio-' + owner.ownerId;
  }

  async #asset(filename: string): Promise<string> {
    return (await readFile(join(this.#options.assetDir, filename), 'utf8')).replace(/\r\n/g, '\n');
  }

  async #wsl(args: readonly string[], label: string, options: RuntimeProcessOptions = {}): Promise<string> {
    const result = await this.#options.runner.run(WSL, args, { timeoutMs: WSL_TIMEOUT, ...options });
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim()).replace(/[\0\uFEFF]/g, '').trim();
      throw new Error(label + (detail ? ' ' + detail.slice(-1200) : ' Exit code ' + String(result.code) + '.'));
    }
    return result.stdout.replace(/[\0\uFEFF]/g, '');
  }

  #inside(owner: Owner, args: readonly string[]): readonly string[] {
    return ['--distribution', this.#name(owner), '--user', 'root', '--cd', '/', '--exec', ...args];
  }

  async #syncAssets(owner: Owner, lock: string): Promise<void> {
    await this.#wsl(this.#inside(owner, ['/usr/bin/install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', HOME, ASSET_DIR]),
      'Cannot prepare the runtime directory.');
    if (owner.lockHash) {
      await this.#wsl(this.#inside(owner, ['/usr/bin/install', '-d', '-o', 'appstudio', '-g', 'appstudio', '-m', '0700', HOME + '/projects']),
        'Cannot prepare the project workspace.');
    }
    for (const filename of ASSETS) {
      await this.#wsl(this.#inside(owner, [
        '/bin/sh', '-c', 'set -eu; umask 022; tmp=$(mktemp "$1.XXXXXXXX"); trap \'rm -f -- "$tmp"\' EXIT; cat > "$tmp"; chmod 0644 "$tmp"; mv -fT -- "$tmp" "$1"',
        'appstudio-asset', ASSET_DIR + '/' + filename,
      ]), 'Cannot install an App Studio runtime asset.', {
        input: filename === 'runtime-lock.json' ? lock : await this.#asset(filename),
        signal: this.#lifetime.signal,
      });
    }
  }

  async #verifyOwner(owner: Owner): Promise<void> {
    if (!owner.imported) throw new Error('App Studio could not confirm ownership of the WSL distribution.');
    const actual = await this.#wsl(this.#inside(owner, ['/bin/cat', HOME + '/owner']), 'Cannot verify WSL runtime ownership.');
    if (actual.trim() !== owner.ownerId) throw new Error('The WSL distribution does not belong to this App Studio profile.');
  }

  #requireLicense(accepted: boolean): void {
    if (!accepted) throw new Error('Accept the Android SDK license before preparing the runtime.');
  }

  async #rootfs(lock: string): Promise<string> {
    const wsl = asRecord(asRecord(JSON.parse(lock))?.wsl);
    const name = wsl?.rootfs;
    const hash = wsl?.rootfsSha256;
    if (typeof name !== 'string' || !/^ubuntu-base-\d+\.\d+\.\d+-base-amd64\.tar\.gz$/.test(name) ||
        typeof hash !== 'string' || !/^[\da-f]{64}$/.test(hash)) throw new Error('Invalid WSL root filesystem version lock.');
    const target = join(this.#options.dataDir, name);
    try {
      const bytes = await readFile(target);
      if (bytes.length <= ROOTFS_LIMIT && sha256(bytes) === hash) return target;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const response = await fetch(ROOTFS_ORIGIN + name, {
      signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(INSTALL_TIMEOUT)]),
    });
    if (!response.ok || !response.body) throw new Error('Cannot download the pinned Ubuntu root filesystem.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > ROOTFS_LIMIT) throw new Error('Ubuntu root filesystem exceeds its download limit.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks, size);
    if (sha256(bytes) !== hash) throw new Error('Ubuntu root filesystem checksum does not match the version lock.');
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return target;
  }

  async #prepare(licenseAccepted: boolean): Promise<RuntimeStatus> {
    const lock = await this.#asset('runtime-lock.json');
    const lockHash = sha256(lock);
    let owner = await this.#readOwner();
    if (owner?.lockHash === lockHash) {
      if (!this.#running) this.#set('stopped', 'Android Runtime is configured.');
      return this.status();
    }
    if (owner?.lockHash) throw new Error('The runtime version changed. Reinitialize the environment.');
    this.#requireLicense(licenseAccepted);
    this.#set('preparing', 'Checking WSL2 and the pinned base image.');
    await this.#wsl(['--version'], 'Cannot use WSL2. Install or update WSL first.');
    await mkdir(this.#options.dataDir, { recursive: true });
    if (!owner) {
      owner = { ownerId: randomUUID(), imported: false };
      await writeFile(this.#ownerFile, JSON.stringify(owner) + '\n', { flag: 'wx' });
    }
    if (!owner.imported) {
      const archive = await this.#rootfs(lock);
      const location = join(this.#options.dataDir, this.#name(owner));
      await mkdir(location, { recursive: true });
      this.#set('preparing', 'Importing the dedicated WSL2 distribution.');
      await this.#wsl(['--import', this.#name(owner), location, archive, '--version', '2'], 'Cannot import the App Studio distribution.', {
        timeoutMs: INSTALL_TIMEOUT, signal: this.#lifetime.signal,
      });
      owner = { ...owner, imported: true };
      await this.#saveOwner(owner);
      await this.#wsl(this.#inside(owner, [
        '/bin/sh', '-c', 'set -eu; install -d -m 0755 /opt/appstudio; set -C; printf "%s\\n" "$1" > /opt/appstudio/owner',
        'appstudio-owner', owner.ownerId,
      ]), 'Cannot record ownership of the App Studio distribution.');
    }
    await this.#verifyOwner(owner);
    let installationFailed = false;
    try {
      this.#set('preparing', 'Installing the pinned Android SDK, system image, and RTC Gateway.');
      await this.#syncAssets(owner, lock);
      await this.#wsl(this.#inside(owner, ['/bin/bash', ASSET_DIR + '/bootstrap.sh', owner.ownerId]),
        'Cannot install the pinned Android Runtime.', { timeoutMs: INSTALL_TIMEOUT, signal: this.#lifetime.signal });
      await this.#saveOwner({ ...owner, lockHash });
    } catch (error) {
      installationFailed = true;
      throw error;
    } finally {
      await this.#wsl(['--terminate', this.#name(owner)], 'Cannot stop the dedicated WSL2 distribution.').catch(error => {
        if (!installationFailed) throw error;
      });
    }
    this.#set('stopped', 'Android Runtime is configured.');
    return this.status();
  }

  async #start(): Promise<RuntimeEndpoint> {
    const current = this.currentEndpoint();
    if (current && this.#running) {
      if (this.#running.uses === 0) this.#armIdle(this.#running);
      return current;
    }
    if (this.#running) await this.#stop();
    const owner = await this.#readOwner();
    if (!owner?.lockHash) throw new Error('Prepare the Android Runtime before starting Live.');
    const lock = await this.#asset('runtime-lock.json');
    if (owner.lockHash !== sha256(lock)) {
      throw new Error('The runtime version changed. Reinitialize the environment.');
    }
    this.#set('starting', 'Starting the dedicated Android emulators.');
    await this.#verifyOwner(owner);
    await this.#syncAssets(owner, lock);
    this.#lifetime.signal.throwIfAborted();
    const child = await this.#options.runner.spawn(
      WSL, this.#inside(owner, ['/bin/bash', ASSET_DIR + '/start.sh', owner.ownerId]),
    );
    const active: ActiveRuntime = { owner, child, claimed: false, uses: 0, lifetime: new AbortController() };
    this.#running = active;
    let stderr = '';
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderr = (stderr + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))).slice(-1200);
      }
    })().catch(() => {});
    const finished = child.completion.then(
      ({ code }) => new Error('Android Runtime exited (' + String(code) + ').' + (stderr.trim() ? ' ' + stderr.trim() : '')),
      () => new Error('The App Studio runtime subprocess disconnected.'),
    );
    let exitError: Error | undefined;
    void finished.then(error => {
      exitError = error;
      if (this.#running === active && active.endpoint && this.#phase === 'running') {
        active.lifetime.abort();
        this.#clearIdle(active);
        active.endpoint = undefined;
        this.#set('error', error.message);
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    try {
      const endpoint = await new Promise<RuntimeEndpoint>((resolve, reject) => {
        cancel = () => reject(new Error('App Studio Android Runtime startup was canceled.'));
        if (this.#lifetime.signal.aborted) cancel();
        this.#lifetime.signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => reject(new Error('Timed out waiting for both Android devices and the RTC Gateway.')), START_TIMEOUT);
        void finished.then(reject);
        void readEndpoint(child.stdout, () => { active.claimed = true; }, resolve).catch(() => {
          reject(new Error('The App Studio Gateway did not return a valid startup message.'));
        });
      });
      if (exitError) throw exitError;
      active.endpoint = endpoint;
      this.#set('running', 'Live and candidate Android devices are ready.');
      this.#armIdle(active);
      return endpoint;
    } catch (error) {
      await this.#release(active).catch(() => {});
      throw error;
    } finally {
      this.#lifetime.signal.removeEventListener('abort', cancel);
      clearTimeout(timer);
    }
  }

  async #release(active: ActiveRuntime): Promise<void> {
    active.lifetime.abort();
    this.#clearIdle(active);
    if (active.claimed) {
      const { owner, child } = active;
      try {
        await this.#verifyOwner(owner);
      } catch (error) {
        await child.stop().catch(() => {});
        throw error;
      }
      await this.#wsl(this.#inside(owner, ['/bin/bash', ASSET_DIR + '/start.sh', '--stop', owner.ownerId]),
        'Cannot gracefully stop the Android devices.').catch(() => {});
      await child.stop().catch(() => {});
      await this.#wsl(['--terminate', this.#name(owner)], 'Cannot stop the dedicated WSL2 distribution.');
    } else {
      await active.child.stop();
    }
    this.#running = undefined;
  }

  async #stop(): Promise<RuntimeStatus> {
    const running = this.#running;
    if (!running) return this.status();
    this.#set('stopping', 'Stopping the App Studio Android devices.');
    running.endpoint = undefined;
    await this.#release(running);
    this.#set('stopped', 'Android Runtime is configured.');
    return this.status();
  }

  async #uninstall(): Promise<RuntimeStatus> {
    const owner = await this.#readOwner();
    if (owner?.imported) {
      if (this.#running) await this.#stop();
      this.#set('stopping', 'Removing the dedicated App Studio WSL2 distribution.');
      await this.#verifyOwner(owner);
      await this.#wsl(['--unregister', this.#name(owner)], 'Cannot uninstall the dedicated App Studio distribution.');
    } else if (owner) {
      const existing = await this.#options.runner.run(WSL, ['--list', '--quiet'], { timeoutMs: WSL_TIMEOUT });
      if (existing.code !== 0) throw new Error('Cannot determine if the dedicated WSL2 distribution was registered.');
      const names = existing.stdout.replace(/[\0\uFEFF]/g, '').split(/\r?\n/).map(name => name.trim());
      if (names.includes(this.#name(owner))) throw new Error('App Studio cannot confirm ownership of the registered WSL distribution.');
    }
    await rm(this.#ownerFile, { force: true });
    this.#set('unconfigured', 'Prepare the dedicated Android Runtime to continue.');
    return this.status();
  }
}
