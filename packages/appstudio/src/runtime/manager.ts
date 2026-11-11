import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { deploymentFile, deploymentRecord } from '../project/deployment.ts';
import type { DeviceRole, FrameworkId, RuntimeIssue } from '../shared/protocol.ts';
import { diagnosticIssue, hostPrerequisite, RuntimeProblem, runtimeIssue, safeRuntimeOutput } from './diagnostics.ts';

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
  id: DeviceRole;
  width: number;
  height: number;
}

/** Host-only credentials for the loopback Gateway. */
export interface RuntimeEndpoint {
  gatewayUrl: string;
  token: string;
  devices: RuntimeDevice[];
  healthCheck?: true;
}

export interface RuntimeStatus {
  phase: 'unsupported' | 'unconfigured' | 'preparing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  detail: string;
  devices: RuntimeDevice[];
  issue?: RuntimeIssue;
  configured?: boolean;
  background?: 'starting' | 'failed';
  resumeExpected?: boolean;
}

export interface RuntimeManagerOptions {
  /** An absolute, profile-owned Windows storage directory. */
  dataDir: string;
  assetDir: string;
  runner: RuntimeProcessRunner;
  platform?: NodeJS.Platform;
  architecture?: string;
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
  deviceEvents: EventTarget;
  backgroundFailed: boolean;
  backgroundProblem?: RuntimeProblem;
  deferBackground: boolean;
  backgroundRequested: boolean;
  resumeExpected: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  endpoint?: RuntimeEndpoint;
}

const WSL = 'wsl.exe';
const HOME = '/opt/appstudio';
const ASSET_DIR = HOME + '/runtime';
const ASSETS = ['runtime-lock.json', 'bootstrap.sh', 'sdk-metadata.sh', 'install-gateway.sh', 'start.sh', 'gateway.py', 'gpu_probe.py', 'android_scene.py',
  'rtc-allowlist.json', 'build-tools.sh', 'build-tools-lock.json', 'react-native.init.gradle'];
const WSL_TIMEOUT = 30_000;
const START_TIMEOUT = 6 * 60_000;
const IDLE_TIMEOUT = 30_000;
const INSTALL_TIMEOUT = 30 * 60_000;
const ROOTFS_LIMIT = 96 * 1024 * 1024;
const ROOTFS_ORIGIN = 'https://cdimages.ubuntu.com/ubuntu-base/releases/24.04/release/';
const backgroundError = 'The background Android device could not start.';

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

class StartupProtocolError extends Error {}

function deviceFromJson(entry: unknown): RuntimeDevice {
  const device = asRecord(entry);
  const id = device?.id;
  const width = device?.width;
  const height = device?.height;
  if ((id !== 'live' && id !== 'candidate') || typeof width !== 'number' || typeof height !== 'number' ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 8192 || height > 8192) throw new StartupProtocolError('The device descriptor is invalid.');
  return { id, width, height };
}

function endpointFromJson(record: Record<string, unknown>, primary: DeviceRole): RuntimeEndpoint {
  const { gatewayUrl, token, devices } = record;
  if (typeof gatewayUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(gatewayUrl) ||
      typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token) || !Array.isArray(devices)) {
    throw new StartupProtocolError('The loopback endpoint is invalid.');
  }
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new StartupProtocolError('The loopback endpoint is invalid.');
  }
  if (!url.port || Number(url.port) === 0) throw new StartupProtocolError('The loopback port is invalid.');
  const mapped = devices.map(deviceFromJson);
  if (mapped.length > 2 || !mapped.some(device => device.id === primary) ||
      new Set(mapped.map(device => device.id)).size !== mapped.length) {
    throw new StartupProtocolError('The expected Android device is missing or duplicated.');
  }
  return { gatewayUrl: url.origin, token, devices: mapped, ...(record.healthCheck === true && { healthCheck: true as const }) };
}

async function verifyGateway(endpoint: RuntimeEndpoint, signal: AbortSignal): Promise<void> {
  if (!endpoint.healthCheck) return;
  const url = new URL('/v1/health', endpoint.gatewayUrl);
  const deadline = Date.now() + 10_000;
  let detail = '';
  for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        redirect: 'error', headers: { Authorization: 'Bearer ' + endpoint.token },
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(1_500, remaining))]),
      });
      await response.body?.cancel().catch(() => {});
      if (response.status === 204) return;
      detail = `HTTP ${response.status}.`;
      if (response.status !== 503 && response.status !== 502) break;
    } catch (error) {
      signal.throwIfAborted();
      const failure = asRecord(error);
      const code = asRecord(failure?.cause)?.code ?? failure?.code;
      detail = typeof code === 'string' && /^(?:E[A-Z0-9]+|UND_ERR_[A-Z_]+)$/.test(code) ? code + '.'
        : error instanceof Error && error.name === 'TimeoutError' ? 'The local request timed out.' : 'The local connection failed.';
    }
    remaining = deadline - Date.now();
    if (remaining > 0) await pause(Math.min(400, remaining), undefined, { signal });
  }
  throw new RuntimeProblem('gateway-loopback', 'The Android gateway is running in WSL2, but Windows cannot reach it through 127.0.0.1.' +
    (detail ? ' ' + detail : ''));
}

/** Consume the supervisor's machine output without logging its credentials. */
async function readEndpoint(
  stdout: RuntimeChild['stdout'],
  primary: DeviceRole,
  claimed: () => void,
  ready: (value: RuntimeEndpoint) => void,
  background: (device?: RuntimeDevice, problem?: RuntimeProblem) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  let endpoint: RuntimeEndpoint | undefined;
  let backgroundComplete = false;
  for await (const chunk of stdout) {
    if (backgroundComplete) continue;
    buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    while (buffered.includes('\n')) {
      const line = buffered.slice(0, buffered.indexOf('\n')).trim();
      buffered = buffered.slice(buffered.indexOf('\n') + 1);
      if (!line.startsWith('{')) continue;
      let message: Record<string, unknown> | undefined;
      try {
        message = asRecord(JSON.parse(line));
      } catch {
        throw new StartupProtocolError('The supervisor reported malformed JSON.');
      }
      if (!message) continue;
      if (message.event === 'starting' && !endpoint) claimed();
      if (message.event === 'ready') {
        if (endpoint) throw new StartupProtocolError('The supervisor announced multiple endpoints.');
        endpoint = endpointFromJson(message, primary);
        backgroundComplete = endpoint.devices.length === 2;
        claimed();
        ready(endpoint);
      } else if (message.event === 'device-ready' || message.event === 'device-error') {
        if (!endpoint) throw new StartupProtocolError('The supervisor announced a device before its endpoint.');
        const device = message.event === 'device-ready' ? deviceFromJson(message.device) : undefined;
        const role = device?.id ?? message.role;
        if ((role !== 'live' && role !== 'candidate') || role === primary) {
          throw new StartupProtocolError('The supervisor announced an unexpected background device.');
        }
        backgroundComplete = true;
        const detail = typeof message.detail === 'string' ? safeRuntimeOutput(message.detail.slice(0, 600)) : '';
        background(device, device ? undefined : new RuntimeProblem(runtimeIssue(message.code) ?? 'avd-startup',
          backgroundError + (detail ? ' ' + detail : '')));
      }
      if (backgroundComplete) break;
    }
    if (!backgroundComplete && buffered.length > 8192) throw new StartupProtocolError('The startup message exceeds the size limit.');
  }
  if (endpoint && !backgroundComplete) throw new Error('App Studio Gateway did not report background device readiness.');
}

/** Owns the Android distribution and its two-device process for one DSH profile. */
export class AndroidRuntimeManager {
  readonly #options: RuntimeManagerOptions;
  readonly #unsupported?: RuntimeProblem;
  readonly #lifetime = new AbortController();
  #tail: Promise<void> = Promise.resolve();
  #phase: RuntimeStatus['phase'] | undefined;
  #detail = '';
  #issue?: RuntimeIssue;
  #wslProbe?: { expires: number; result: Promise<void> };
  #failedProbe?: RuntimeProblem;
  #recoverPreflight = false;
  #running: ActiveRuntime | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: RuntimeManagerOptions) {
    this.#options = options;
    if ((options.platform ?? process.platform) !== 'win32') {
      this.#unsupported = new RuntimeProblem('host-platform', 'Android Runtime requires Windows and WSL2.');
    } else if ((options.architecture ?? process.arch) !== 'x64') {
      this.#unsupported = new RuntimeProblem('host-architecture', 'This Android runtime requires a Windows x64 host.');
    }
  }

  async status(): Promise<RuntimeStatus> {
    if (this.#unsupported) {
      return { phase: 'unsupported', issue: this.#unsupported.issue, detail: this.#unsupported.message, devices: [], configured: false };
    }
    const ownerRecord = this.#readOwner();
    const configured = !!(await ownerRecord.catch(() => undefined))?.lockHash;
    if (!this.#phase || this.#recoverPreflight) {
      const previousIssue = this.#issue;
      try {
        await this.#checkWsl();
        if (previousIssue && this.#recoverPreflight && this.#issue === previousIssue) {
          this.#phase = undefined;
          this.#issue = undefined;
          this.#recoverPreflight = false;
        }
      } catch (error) {
        if (error instanceof RuntimeProblem) return { phase: 'error', issue: error.issue, detail: error.message, devices: [], configured };
        throw error;
      }
    }
    if (this.#phase) {
      const active = this.#running;
      const devices = active?.endpoint?.devices.map(device => ({ ...device })) ?? [];
      return {
        phase: this.#phase, detail: this.#detail, devices, issue: this.#issue, configured,
        ...(this.#phase === 'running' && devices.length === 1 && {
          background: active?.backgroundFailed ? 'failed' : 'starting',
        }),
        ...(this.#phase === 'running' && active?.resumeExpected && { resumeExpected: true }),
      };
    }
    try {
      const owner = await ownerRecord;
      if (owner?.lockHash) {
        if (owner.lockHash !== sha256(await this.#asset('runtime-lock.json'))) {
          return { phase: 'error', issue: 'runtime-version', detail: 'The runtime version changed. Reinitialize the environment.', devices: [], configured };
        }
        return { phase: 'stopped', detail: 'Android Runtime is configured.', devices: [], configured };
      }
      return { phase: 'unconfigured', detail: 'Prepare the dedicated Android Runtime to continue.', devices: [], configured };
    } catch (error) {
      return { phase: 'error', issue: 'runtime-ownership', detail: safeRuntimeOutput(errorText(error)), devices: [], configured };
    }
  }

  currentEndpoint(): RuntimeEndpoint | undefined {
    if (this.#phase === 'running' && !this.#disposed) return this.#running?.endpoint;
    return undefined;
  }

  activeOwner(endpoint: RuntimeEndpoint): string | undefined {
    if (this.currentEndpoint() === endpoint) return this.#running?.owner.ownerId;
    return undefined;
  }

  endpointSignal(endpoint: RuntimeEndpoint): AbortSignal {
    return this.#activeProjectRuntime(endpoint).lifetime.signal;
  }

  async waitForDevice(endpoint: RuntimeEndpoint, role: DeviceRole, signal: AbortSignal): Promise<void> {
    const active = this.#activeProjectRuntime(endpoint);
    const lifetime = AbortSignal.any([signal, active.lifetime.signal]);
    const ready = () => endpoint.devices.some(device => device.id === role);
    lifetime.throwIfAborted();
    if (!ready() && !active.backgroundFailed && active.deferBackground && !active.backgroundRequested) {
      const url = new URL('/v1/background/start', endpoint.gatewayUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
        throw new Error('Invalid Android gateway address.');
      }
      try {
        const response = await fetch(url, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: 'Bearer ' + endpoint.token },
          signal: AbortSignal.any([lifetime, AbortSignal.timeout(5_000)]),
        });
        await response.body?.cancel().catch(() => {});
        if (response.status !== 204) throw new Error('The Android gateway rejected the background startup request.');
        active.backgroundRequested = true;
      } catch {
        lifetime.throwIfAborted();
        if (!ready() && !active.backgroundFailed) throw new Error('Could not request startup of the background Android device.');
      }
    }
    if (!ready() && !active.backgroundFailed) await once(active.deviceEvents, 'ready', { signal: lifetime });
    lifetime.throwIfAborted();
    if (!ready()) throw active.backgroundProblem ?? new Error(backgroundError);
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

  start(options?: { deferBackground?: boolean }): Promise<RuntimeEndpoint> {
    return this.#operate(() => this.#start(options?.deferBackground === true));
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
      await this.#checkWsl(true);
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
      if (this.#unsupported) throw this.#unsupported;
      if (this.#disposed) throw new Error('App Studio runtime manager has been disposed.');
      try {
        return await operation();
      } catch (error) {
        this.#set('error', safeRuntimeOutput(errorText(error)), error instanceof RuntimeProblem ? error.issue : diagnosticIssue(errorText(error)));
        this.#recoverPreflight = error === this.#failedProbe;
        throw error;
      }
    });
    this.#tail = result.then(() => {}, () => {});
    return result;
  }

  #set(phase: RuntimeStatus['phase'], detail: string, issue?: RuntimeIssue): void {
    this.#phase = phase;
    this.#detail = detail;
    this.#issue = issue;
    this.#recoverPreflight = false;
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
      const output = result.stderr.trim() || result.stdout.trim();
      const detail = safeRuntimeOutput(output);
      const message = label + (detail ? ' ' + detail : ' Exit code ' + String(result.code) + '.');
      const issue = diagnosticIssue(result.stderr + '\n' + result.stdout);
      if (issue) throw new RuntimeProblem(issue, message);
      throw new Error(message);
    }
    return result.stdout.replace(/[\0\uFEFF]/g, '');
  }

  #checkWsl(force = false): Promise<void> {
    const previous = this.#wslProbe;
    if (previous && (previous.expires === Infinity || (!force && previous.expires > Date.now()))) return previous.result;
    const label = 'Cannot use WSL2. Install or update WSL first.';
    const result = this.#wsl(['--status'], label, { timeoutMs: 6_000, signal: this.#lifetime.signal }).then(output => {
      const issue = diagnosticIssue(output);
      if (issue && hostPrerequisite(issue)) throw new RuntimeProblem(issue, label + ' ' + safeRuntimeOutput(output));
    }).catch((error: unknown) => {
      this.#lifetime.signal.throwIfAborted();
      const detail = safeRuntimeOutput(errorText(error));
      this.#failedProbe = error instanceof RuntimeProblem && hostPrerequisite(error.issue) ? error
        : new RuntimeProblem('wsl-unavailable', detail.startsWith(label) ? detail : label + ' ' + detail);
      throw this.#failedProbe;
    });
    const probe = { expires: Infinity, result };
    this.#wslProbe = probe;
    void result.then(() => { probe.expires = Date.now() + 15_000; }, () => { probe.expires = Date.now() + 4_000; });
    return result;
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
    if (!owner.imported) throw new RuntimeProblem('runtime-ownership', 'App Studio could not confirm ownership of the WSL distribution.');
    const actual = await this.#wsl(this.#inside(owner, ['/bin/cat', HOME + '/owner']), 'Cannot verify WSL runtime ownership.').catch(error => {
      if (error instanceof RuntimeProblem) throw error;
      throw new RuntimeProblem('runtime-ownership', safeRuntimeOutput(errorText(error)));
    });
    if (actual.trim() !== owner.ownerId) throw new RuntimeProblem('runtime-ownership', 'The WSL distribution does not belong to this App Studio profile.');
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
    }).catch(() => {
      this.#lifetime.signal.throwIfAborted();
      throw new RuntimeProblem('rootfs-download', 'Cannot connect to the Ubuntu base image download server.');
    });
    if (!response.ok || !response.body) {
      throw new RuntimeProblem('rootfs-download', `Cannot download the pinned Ubuntu root filesystem (HTTP ${response.status}).`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read().catch(() => {
          this.#lifetime.signal.throwIfAborted();
          throw new RuntimeProblem('rootfs-download', 'The Ubuntu base image download was interrupted.');
        });
        if (part.done) break;
        size += part.value.byteLength;
        if (size > ROOTFS_LIMIT) throw new RuntimeProblem('rootfs-integrity', 'Ubuntu root filesystem exceeds its download limit.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks, size);
    if (sha256(bytes) !== hash) throw new RuntimeProblem('rootfs-integrity', 'Ubuntu root filesystem checksum does not match the version lock.');
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
    const repair = this.#phase === 'error' && (this.#issue === 'sdk-invalid' || this.#issue === 'gateway-dependencies');
    if (owner?.lockHash === lockHash && !repair) {
      if (!this.#running) this.#set('stopped', 'Android Runtime is configured.');
      return this.status();
    }
    if (owner?.lockHash && owner.lockHash !== lockHash) {
      throw new RuntimeProblem('runtime-version', 'The runtime version changed. Reinitialize the environment.');
    }
    this.#requireLicense(licenseAccepted);
    this.#set('preparing', 'Checking WSL2 and the pinned base image.');
    await this.#checkWsl(true);
    if (repair && this.#running) await this.#stop();
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

  async #start(deferBackground: boolean): Promise<RuntimeEndpoint> {
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
      throw new RuntimeProblem('runtime-version', 'The runtime version changed. Reinitialize the environment.');
    }
    this.#set('starting', 'Starting the current Android device.');
    await this.#checkWsl(true);
    await this.#verifyOwner(owner);
    await this.#syncAssets(owner, lock);
    const saved = deploymentRecord.safeParse(await readFile(join(this.#options.dataDir, deploymentFile), 'utf8')
      .then(text => JSON.parse(text) as unknown).catch(() => undefined));
    const deployment = saved.success && saved.data.ownerId === owner.ownerId ? saved.data.project : undefined;
    const primary = deployment?.activeRole ?? 'live';
    this.#lifetime.signal.throwIfAborted();
    const child = await this.#options.runner.spawn(
      WSL, this.#inside(owner, ['/bin/bash', ASSET_DIR + '/start.sh', owner.ownerId, primary, ...(deferBackground ? ['after-preview'] : [])]),
    );
    const active: ActiveRuntime = {
      owner, child, claimed: false, uses: 0, lifetime: new AbortController(), deviceEvents: new EventTarget(),
      backgroundFailed: false, deferBackground, backgroundRequested: false, resumeExpected: !!deployment,
    };
    this.#running = active;
    let stderr = '';
    const stderrComplete = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderr = (stderr + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))).slice(-8192);
      }
    })().catch(() => {});
    const finished = child.completion.then(
      async ({ code }) => {
        await Promise.race([stderrComplete, pause(250, undefined, { ref: false })]);
        const detail = safeRuntimeOutput(stderr);
        return new RuntimeProblem(diagnosticIssue(stderr) ?? 'gateway-startup',
          'Android Runtime exited (' + String(code) + ').' + (detail ? ' ' + detail : ''));
      },
      () => new Error('The App Studio runtime subprocess disconnected.'),
    );
    let exitError: Error | undefined;
    void finished.then(error => {
      exitError = error;
      if (this.#running === active && active.endpoint && this.#phase === 'running') {
        active.lifetime.abort();
        this.#clearIdle(active);
        active.endpoint = undefined;
        this.#set('error', error.message, error instanceof RuntimeProblem ? error.issue : 'gateway-startup');
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const describeReadiness = () => this.#set('running', active.endpoint?.devices.length === 2
      ? 'Live and candidate Android devices are ready.'
      : active.backgroundProblem?.message ?? 'The current Android device is ready. Starting the background device.', active.backgroundProblem?.issue);
    const background = (device?: RuntimeDevice, problem?: RuntimeProblem) => {
      if (this.#running !== active || !active.endpoint || active.endpoint.devices.length !== 1 ||
          active.backgroundFailed || active.lifetime.signal.aborted) return;
      if (device) active.endpoint.devices.push(device);
      else {
        active.backgroundFailed = true;
        active.backgroundProblem = problem ?? new RuntimeProblem('avd-startup', backgroundError);
      }
      if (this.#phase === 'running') describeReadiness();
      active.deviceEvents.dispatchEvent(new Event('ready'));
    };
    try {
      const endpoint = await new Promise<RuntimeEndpoint>((resolve, reject) => {
        cancel = () => reject(new Error('App Studio Android Runtime startup was canceled.'));
        if (this.#lifetime.signal.aborted) cancel();
        this.#lifetime.signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => reject(new RuntimeProblem('gateway-startup',
          'Timed out waiting for the current Android device and the RTC Gateway.')), START_TIMEOUT);
        void finished.then(reject);
        void readEndpoint(child.stdout, primary, () => { active.claimed = true; }, value => {
          active.endpoint = value;
          void verifyGateway(value, active.lifetime.signal).then(() => resolve(value), reject);
        }, background).catch((error: unknown) => {
          if (active.endpoint) background();
          else {
            const detail = error instanceof StartupProtocolError ? error.message : 'The startup output could not be read.';
            reject(new RuntimeProblem('gateway-startup', 'The App Studio Gateway did not return a valid startup message. ' + detail));
          }
        });
      });
      if (exitError) throw exitError;
      describeReadiness();
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
      const registered = await this.#verifyOwner(owner).then(() => true, error => {
        if (error instanceof RuntimeProblem && error.issue === 'runtime-missing') return false;
        throw error;
      });
      if (registered) await this.#wsl(['--unregister', this.#name(owner)], 'Cannot uninstall the dedicated App Studio distribution.');
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
