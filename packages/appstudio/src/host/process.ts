import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { RuntimeProcessRunner } from '../runtime/manager.ts'

export function runtimeProcesses(subprocess: SubprocessRuntime, cwd: string): RuntimeProcessRunner {
  const env = { WSL_UTF8: '1' }
  return {
    async run(command, args, options) {
      const signals = [options?.signal, options?.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)]
      const signal = AbortSignal.any(signals.filter((entry): entry is AbortSignal => entry !== undefined))
      const executable = await subprocess.resolveExecutable(command, env, signal)
      const child = subprocess.spawn({
        argv: [executable, ...args], cwd, env, signal, graceMs: 3000,
        stdio: {
          stdin: options?.inputStream ? 'pipe' : options?.input === undefined ? 'ignore' : { data: options.input },
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
      })
      const copy = options?.inputStream
        ? pipeline(Readable.from(options.inputStream), child.stdin!, { signal }).catch((error: unknown) => {
          child.terminate()
          throw error
        })
        : Promise.resolve()
      const [{ exitCode }] = await Promise.all([child.done, copy])
      signal.throwIfAborted()
      return {
        code: exitCode ?? 1,
        stdout: child.collected.stdout!.readFrom(0).text,
        stderr: child.collected.stderr!.readFrom(0).text,
      }
    },
    async spawn(command, args, options) {
      const executable = await subprocess.resolveExecutable(command, env, options?.signal)
      const child = subprocess.spawn({
        argv: [executable, ...args], cwd, env, signal: options?.signal, graceMs: 3000,
        stdio: { stdin: options?.input === undefined ? 'ignore' : { data: options.input }, stdout: 'pipe', stderr: 'pipe' },
      })
      return {
        stdout: child.stdout!.setEncoding('utf8'),
        stderr: child.stderr!.setEncoding('utf8'),
        completion: child.done.then(({ exitCode }) => ({ code: exitCode })),
        async stop() {
          child.terminate()
          await child.waitForExit()
        },
      }
    },
  }
}
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
