import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CandidateFiles, type CandidateLease } from '../src/iteration/candidate-tools.ts'
import { iterationReceipt } from '../src/iteration/sessions.ts'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'appstudio-candidate-tools-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const candidate = join(root, 'candidate')
  await mkdir(source)
  await mkdir(candidate)
  return { source, candidate, signal: new AbortController().signal }
}

test('candidate edits preserve the source, text encoding, and unique match requirement', async t => {
  const { source, candidate, signal } = await fixture(t)
  const filename = 'Main.kt'
  const before = '\uFEFFa\r\nb\r\nc\r\n'
  await writeFile(join(source, filename), before)
  await writeFile(join(candidate, filename), before)
  const files = new CandidateFiles(source, () => ({ root: candidate, batchId: 'one' }))
  await files.edit(filename, 'b\nc', 'y\nz', signal)
  assert.equal(await readFile(join(candidate, filename), 'utf8'), '\uFEFFa\r\ny\r\nz\r\n')
  assert.equal(await readFile(join(source, filename), 'utf8'), before)
  await assert.rejects(files.edit(filename, 'missing', 'other', signal), /exactly once/)
  await files.write('new/Extra.kt', 'test', signal)
  assert.match(await files.read('new/Extra.kt', 1, 5, signal), /test/)
  await assert.rejects(files.write('new/Extra.kt', 'overwrite', signal), /already exists/)
  await files.delete('new/Extra.kt', signal)
  await assert.rejects(readFile(join(candidate, 'new/Extra.kt')), { code: 'ENOENT' })
})

test('candidate capability rejects missing leases, links, traversal, and overlap with the source', async t => {
  const { source, candidate, signal } = await fixture(t)
  await writeFile(join(source, 'Original.txt'), 'original')
  await symlink(source, join(candidate, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
  await link(join(source, 'Original.txt'), join(candidate, 'hard.txt'))
  let lease: CandidateLease | undefined = { root: candidate, batchId: 'one' }
  const files = new CandidateFiles(source, () => lease)
  await assert.rejects(files.read('junction/Original.txt', 1, 2, signal), /symbolic links/)
  await assert.rejects(files.read('hard.txt', 1, 2, signal), /text-file limits/)
  for (const path of ['../source/Original.txt', '/Original.txt', '.git/config', 'foo:stream', 'CON.txt', 'file.']) {
    await assert.rejects(files.write(path, 'foreign', signal), /project-relative/)
  }
  lease = { root: source, batchId: 'one' }
  await assert.rejects(files.delete('Original.txt', signal), /separate/)
  lease = undefined
  await assert.rejects(files.list('', signal), /authorized/)
  assert.equal(await readFile(join(source, 'Original.txt'), 'utf8'), 'original')
})

test('candidate tools hide local credential files while keeping environment templates available', async t => {
  const { source, candidate, signal } = await fixture(t)
  const files = new CandidateFiles(source, () => ({ root: candidate, batchId: 'one' }))
  await writeFile(join(candidate, '.env.local'), 'PRIVATE_TEST_VALUE')
  await writeFile(join(candidate, '.env.example'), 'PLACEHOLDER=')
  await writeFile(join(candidate, '.npmrc'), 'PRIVATE_TEST_VALUE')
  assert.equal(await files.list('', signal), '.env.example')
  assert.match(await files.read('.env.example', 1, 1, signal), /PLACEHOLDER=/)
  await assert.rejects(files.read('.env.local', 1, 1, signal), /outside the App Studio candidate tool scope/)
  await assert.rejects(files.delete('.npmrc', signal), /outside the App Studio candidate tool scope/)
  await assert.rejects(files.write('upload.jks', 'test', signal), /outside the App Studio candidate tool scope/)
  assert.equal(await readFile(join(candidate, '.env.local'), 'utf8'), 'PRIVATE_TEST_VALUE')
})

function events(...entries: readonly { type: string, data: object }[]): readonly SessionEvent[] {
  return entries.map((event, seq) => ({ ...event, seq, time: seq })) as unknown as readonly SessionEvent[]
}

test('durable receipt ignores unrelated turns and never repeats admitted pending work', () => {
  const message = (rpcId: string) => ({ source: { kind: 'user', rpcId } })
  const history = events(
    { type: 'agent/inbox/spliced', data: { inserted: [message('this-batch')] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: message('another-batch') },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: message('this-batch') },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'failure' } } } },
  )
  assert.deepEqual(iterationReceipt(history.slice(0, 4), 'this-batch'), { accepted: true })
  assert.deepEqual(iterationReceipt(history, 'this-batch'), {
    accepted: true, settled: { turn: 2, reason: { kind: 'error', error: { message: 'failure' } } },
  })
  assert.deepEqual(iterationReceipt(history, 'unknown'), { accepted: false })
})
