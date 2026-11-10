import { on, once } from 'node:events'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import WebSocket from 'ws'
import { z } from 'zod'
import type { RuntimeDevice, RuntimeEndpoint } from '../runtime/manager.ts'

const SIGNAL_LIMIT = 64 * 1024
const browserSignal = z.union([
  z.strictObject({ type: z.literal('answer'), sdp: z.string().min(1).max(SIGNAL_LIMIT) }),
  z.strictObject({
    candidate: z.string().max(4096),
    sdpMid: z.string().max(128).nullish(),
    sdpMLineIndex: z.int().min(0).max(255).nullish(),
    usernameFragment: z.string().max(256).nullish(),
  }),
  z.strictObject({ bye: z.literal(true) }),
  z.strictObject({ appStudioInput: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('touch'), x: z.int().min(0), y: z.int().min(0), pressure: z.union([z.literal(0), z.literal(1)]) }),
    z.strictObject({ kind: z.literal('key'), key: z.string().min(1).max(64), action: z.union([z.literal(0), z.literal(1), z.literal(2)]) }),
  ]) }),
])

export function checkBrowserSignal(message: string, device: RuntimeDevice): string {
  if (Buffer.byteLength(message) > SIGNAL_LIMIT) throw new Error('Signaling message exceeds the size limit.')
  const value = browserSignal.parse(JSON.parse(message))
  if ('appStudioInput' in value && value.appStudioInput.kind === 'touch') {
    const { x, y } = value.appStudioInput
    const portrait = x < device.width && y < device.height
    const landscape = x < device.height && y < device.width
    if (!portrait && !landscape) throw new Error('Touch coordinates are outside the Android device.')
  }
  return JSON.stringify(value)
}

export async function* relaySignaling(
  endpoint: RuntimeEndpoint,
  device: RuntimeDevice,
  uplink: AsyncIterable<string>,
  signal: AbortSignal,
): AsyncIterable<string> {
  signal.throwIfAborted()
  const url = new URL(endpoint.gatewayUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !/^[A-Za-z0-9_-]{24,128}$/.test(endpoint.token)) {
    throw new RemoteError('gateway/internal', 'Android signaling gateway configuration is invalid.', {})
  }
  url.protocol = 'ws:'
  url.pathname = `/v1/devices/${device.id}/signal`
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${endpoint.token}` },
    handshakeTimeout: 10_000,
    maxPayload: SIGNAL_LIMIT,
    perMessageDeflate: false,
  })
  // ws can emit one last error if terminated during the opening handshake.
  socket.on('error', () => {})
  const local = new AbortController()
  const lifetime = AbortSignal.any([signal, local.signal])
  const messages = on(socket, 'message', { signal: lifetime, close: ['close'], highWaterMark: 32, lowWaterMark: 8 })
  try {
    await once(socket, 'open', { signal: lifetime })
    void (async () => {
      for await (const message of uplink) {
        lifetime.throwIfAborted()
        const payload = checkBrowserSignal(message, device)
        await new Promise<void>((resolve, reject) => {
          socket.send(payload, (error) => error ? reject(error) : resolve())
        })
      }
      if (socket.readyState === WebSocket.OPEN) socket.close()
    })().catch((error: unknown) => local.abort(error))
    for await (const [data, binary] of messages) {
      if (binary || !Buffer.isBuffer(data)) throw new Error('Invalid Android signaling frame.')
      yield data.toString('utf8')
    }
  } catch {
    if (!signal.aborted) throw new RemoteError('gateway/internal', 'Android signaling connection failed.', {})
  } finally {
    local.abort()
    socket.terminate()
    await messages.return?.()
  }
}
