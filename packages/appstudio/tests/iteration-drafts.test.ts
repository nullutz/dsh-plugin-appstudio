import assert from 'node:assert/strict'
import test from 'node:test'
import { nextDrafts, pendingRequest, type PendingBatch } from '../src/client/iteration-drafts.ts'
import type { IterationComment } from '../src/shared/protocol.ts'

const projectRoot = 'C:\\Projects\\studio-project'
const comment = (id: string, text: string): IterationComment => ({
  id, text, selection: { kind: 'point', x: 30, y: 80, width: 0, height: 0 },
  frame: 'data:image/jpeg;base64,AA==', frameWidth: 720, frameHeight: 1280,
})
const first = comment('first', 'Keep the settings screen')
const second = comment('second', 'Add a profile section')
const next = comment('next', 'Move the new profile action')
const batch: PendingBatch = {
  batchId: 'original-batch', sessionId: 'original-session', commentIds: [first.id, second.id], retryOf: null, repairNote: '',
}

test('acknowledging a submitted batch preserves drafts added in the meantime', () => {
  const drafts = [first, next, second]
  assert.deepEqual(nextDrafts(drafts, batch), [next])
  assert.deepEqual(nextDrafts(drafts, undefined), drafts)
})

test('retrying an unconfirmed submission reuses the original payload without next-round drafts', () => {
  const original = pendingRequest(projectRoot, batch, [first, second])
  assert.deepEqual(original?.comments, [first, second])
  assert.equal(JSON.stringify(pendingRequest(projectRoot, batch, [next, second, first])), JSON.stringify(original))
  assert.equal(pendingRequest(projectRoot, batch, [next, second]), undefined)
})

test('retrying retained source does not submit or clear the next round', () => {
  const retry = { ...batch, batchId: 'repair-batch', commentIds: [], retryOf: batch.batchId }
  assert.deepEqual(pendingRequest(projectRoot, retry, [next]), {
    projectRoot, sessionId: batch.sessionId, batchId: retry.batchId, comments: [], retryOf: batch.batchId, repairNote: '',
  })
  assert.deepEqual(nextDrafts([next], retry), [next])
})
