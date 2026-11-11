import { z } from 'zod'
import type { RuntimeEndpoint } from '../runtime/manager.ts'
import type { DeviceRole } from '../shared/protocol.ts'
import type { AndroidArtifact } from './build.ts'

const checkpoint = z.object({
  pid: z.int().positive(),
  versionCode: z.string().regex(/^\d+$/),
  scene: z.record(z.string(), z.json()),
})
export type Checkpoint = z.infer<typeof checkpoint>
const deployment = z.object({
  pid: z.int().positive(),
  previousPid: z.int().positive().nullable(),
  sceneRestored: z.boolean(),
  checkpoint,
})

async function deviceRequest<T>(
  endpoint: RuntimeEndpoint, role: DeviceRole, action: 'capture' | 'deploy' | 'resume',
  body: object, parser: z.ZodType<T>, signal: AbortSignal,
): Promise<T> {
  const url = new URL(`/v1/devices/${role}/${action}`, endpoint.gatewayUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('Invalid Android gateway address.')
  }
  const response = await fetch(url, {
    method: 'POST', redirect: 'error',
    headers: { 'Authorization': `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(330_000)]),
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Android gateway returned an empty response.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 1024 * 1024) throw new Error('Android scene response exceeds the size limit.')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(value)
    throw new Error(error.success ? error.data.error : `Android ${action} failed (${response.status}).`)
  }
  return parser.parse(value)
}

export function captureScene(endpoint: RuntimeEndpoint, role: DeviceRole, applicationId: string, signal: AbortSignal): Promise<Checkpoint> {
  return deviceRequest(endpoint, role, 'capture', { applicationId }, checkpoint, signal)
}

export async function resumeProject(
  endpoint: RuntimeEndpoint, role: DeviceRole, applicationId: string, versionCode: string, signal: AbortSignal,
): Promise<Checkpoint> {
  const result = await deviceRequest(endpoint, role, 'resume', { applicationId, versionCode }, checkpoint, signal)
  if (result.versionCode !== versionCode) throw new Error('The resumed Android app did not verify the expected version.')
  return result
}

export async function deployProject(
  endpoint: RuntimeEndpoint, role: DeviceRole, artifact: AndroidArtifact, scene: Checkpoint | undefined, signal: AbortSignal,
): Promise<z.infer<typeof deployment>> {
  const result = await deviceRequest(endpoint, role, 'deploy', {
    apkPath: artifact.apkPath, applicationId: artifact.applicationId, activity: artifact.launchActivity,
    versionCode: String(artifact.versionCode), checkpoint: scene,
  }, deployment, signal)
  if (result.pid !== result.checkpoint.pid || result.previousPid === result.pid ||
      result.checkpoint.versionCode !== String(artifact.versionCode) || (scene && !result.sceneRestored)) {
    throw new Error('The Android deployment did not verify the new process and requested scene.')
  }
  return result
}
