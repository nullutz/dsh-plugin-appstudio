import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { checkBrowserSignal, relaySignaling } from '../src/host/signaling.ts'

const device = { id: 'candidate', width: 720, height: 1280 } as const
const token = 'test-token-with-at-least-32-characters'

test('validates input against either device orientation and rejects extra fields', () => {
  const landscape = { appStudioInput: { kind: 'touch', x: 1000, y: 500, pressure: 1 } }
  assert.deepEqual(JSON.parse(checkBrowserSignal(JSON.stringify(landscape), device)), landscape)
  assert.throws(() => checkBrowserSignal(JSON.stringify({
    appStudioInput: { ...landscape.appStudioInput, x: 1280 },
  }), device), /outside/)
  assert.throws(() => checkBrowserSignal(JSON.stringify({ bye: true, destination: 'other' }), device))
  assert.equal(checkBrowserSignal('{"appStudioPreviewReady":true}', device), '{"appStudioPreviewReady":true}')
  assert.throws(() => checkBrowserSignal('{"appStudioPreviewReady":true,"role":"live"}', device))
})

test('refuses an untrusted gateway before opening the socket', async () => {
  const endpoint = { gatewayUrl: 'http://192.0.2.1:9000', token, devices: [device] }
  const stream = relaySignaling(endpoint, device, (async function* () {})(), new AbortController().signal)
  await assert.rejects(stream[Symbol.asyncIterator]().next(), /gateway configuration/)
})

test('relays both directions over a role-bound bearer-authenticated socket', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const endpoint = { gatewayUrl: `http://127.0.0.1:${address.port}`, token, devices: [device] }
  const controller = new AbortController()
  const answer = JSON.stringify({ type: 'answer', sdp: 'v=0' })
  const connected = once(server, 'connection')
  const stream = relaySignaling(endpoint, device, (async function* () { yield answer })(), controller.signal)[Symbol.asyncIterator]()
  try {
    const first = stream.next()
    const [socket, request] = await connected
    const inbound = once(socket, 'message')
    assert.equal(request.url, '/v1/devices/candidate/signal')
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    socket.send('{"appStudioInputReady":true}')
    assert.deepEqual(await first, { done: false, value: '{"appStudioInputReady":true}' })
    assert.equal((await inbound)[0].toString(), answer)
    controller.abort()
    assert.equal((await stream.next()).done, true)
  } finally {
    controller.abort()
    await stream.return?.()
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
