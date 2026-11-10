import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { applyCandidateChanges, collectCandidateChanges, createCandidateMirror } from '../src/iteration/changes.ts'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'appstudio-iteration-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const candidate = join(root, 'candidate')
  await mkdir(source)
  return { root, source, candidate }
}

test('applies additions, edits, deletions and binary bytes while preserving unrelated files', async t => {
  const { source, candidate } = await fixture(t)
  const ignored = join(source, 'android', 'app', 'build')
  await mkdir(ignored, { recursive: true })
  await writeFile(join(ignored, 'keep.txt'), 'generated locally')
  await writeFile(join(source, 'edit.txt'), 'before\nkeep\n')
  await writeFile(join(source, 'delete.txt'), 'removed\n')
  await writeFile(join(source, 'asset.bin'), Buffer.from([0, 1, 2]))
  await writeFile(join(source, 'untracked.txt'), 'preexisting untracked content')
  const baseline = JSON.parse(JSON.stringify(await createCandidateMirror(source, candidate)))
  await assert.rejects(readFile(join(candidate, 'android', 'app', 'build', 'keep.txt')), { code: 'ENOENT' })

  await writeFile(join(candidate, 'edit.txt'), 'after\nkeep\n')
  await rm(join(candidate, 'delete.txt'))
  await writeFile(join(candidate, 'asset.bin'), Buffer.from([0, 255, 2]))
  await mkdir(join(candidate, 'nested'))
  await writeFile(join(candidate, 'nested', 'new.txt'), 'added\n')
  await writeFile(join(candidate, '.appstudio-iteration-result.json'), '{"comments":[]}')

  const plan = await collectCandidateChanges(baseline)
  assert.equal(plan.count, 4)
  assert.match(plan.diff, /Binary file changed: asset\.bin/)
  assert.match(plan.diff, /-before[\s\S]*\+after/)
  assert.match(plan.diff, /-removed/)
  assert.match(plan.diff, /\+added/)
  assert.doesNotMatch(plan.diff, /appstudio-iteration-result/)

  await applyCandidateChanges(plan)
  assert.equal(await readFile(join(source, 'edit.txt'), 'utf8'), 'after\nkeep\n')
  assert.equal(await readFile(join(source, 'nested', 'new.txt'), 'utf8'), 'added\n')
  assert.deepEqual(await readFile(join(source, 'asset.bin')), Buffer.from([0, 255, 2]))
  assert.equal(await readFile(join(source, 'untracked.txt'), 'utf8'), 'preexisting untracked content')
  assert.equal(await readFile(join(ignored, 'keep.txt'), 'utf8'), 'generated locally')
  await assert.rejects(readFile(join(source, 'delete.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(source, '.appstudio-iteration-result.json')), { code: 'ENOENT' })
  assert(!(await readdir(source)).includes('.appstudio-apply-lock'))
})

test('refuses stale source and candidate plans before publishing', async t => {
  const { source, candidate } = await fixture(t)
  await writeFile(join(source, 'file.txt'), 'original')
  const baseline = await createCandidateMirror(source, candidate)
  await writeFile(join(candidate, 'file.txt'), 'candidate')
  const plan = await collectCandidateChanges(baseline)
  await writeFile(join(source, 'local-new.txt'), 'concurrent untracked edit')
  await assert.rejects(applyCandidateChanges(plan), /project changed.*local-new\.txt/i)
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'original')
  assert.equal(await readFile(join(source, 'local-new.txt'), 'utf8'), 'concurrent untracked edit')

  await rm(join(source, 'local-new.txt'))
  await writeFile(join(candidate, 'file.txt'), 'candidate edited after validation')
  await assert.rejects(applyCandidateChanges(plan), /candidate changed after validation/i)
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'original')
  const refreshed = await collectCandidateChanges(baseline)
  await applyCandidateChanges(refreshed)
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'candidate edited after validation')
})

test('rolls back an earlier published change when an ignored directory blocks a later change', async t => {
  const { source, candidate } = await fixture(t)
  await mkdir(join(source, 'z', 'node_modules'), { recursive: true })
  await writeFile(join(source, 'z', 'node_modules', 'local.txt'), 'keep local cache')
  await writeFile(join(source, 'z', 'tracked.txt'), 'original nested source')
  await writeFile(join(source, 'a.txt'), 'original first source')
  const baseline = await createCandidateMirror(source, candidate)
  await writeFile(join(candidate, 'a.txt'), 'first change')
  await rm(join(candidate, 'z'), { recursive: true })
  await writeFile(join(candidate, 'z'), 'replace directory')
  const plan = await collectCandidateChanges(baseline)
  await assert.rejects(applyCandidateChanges(plan), { code: 'ENOTEMPTY' })
  assert.equal(await readFile(join(source, 'a.txt'), 'utf8'), 'original first source')
  assert.equal(await readFile(join(source, 'z', 'tracked.txt'), 'utf8'), 'original nested source')
  assert.equal(await readFile(join(source, 'z', 'node_modules', 'local.txt'), 'utf8'), 'keep local cache')
  assert(!(await readdir(source)).includes('.appstudio-apply-lock'))
})

test('rejects junctions, hardlinks, overlapping roots and unsafe persisted paths', async t => {
  const { root, source, candidate } = await fixture(t)
  const external = join(root, 'external')
  await mkdir(external)
  await writeFile(join(external, 'outside.txt'), 'external')
  await symlink(external, join(source, 'unsafe-link'), 'junction')
  await assert.rejects(createCandidateMirror(source, candidate), /unlinked project file/)
  await rm(join(source, 'unsafe-link'))
  await link(join(external, 'outside.txt'), join(source, 'unsafe-hardlink.txt'))
  await assert.rejects(createCandidateMirror(source, candidate), /unlinked project file/)
  await rm(join(source, 'unsafe-hardlink.txt'))
  await assert.rejects(createCandidateMirror(source, join(source, 'nested')), /outside the original/)

  await writeFile(join(source, 'safe.txt'), 'safe')
  const baseline = await createCandidateMirror(source, candidate)
  baseline.files[0].path = '../external/outside.txt'
  await assert.rejects(collectCandidateChanges(baseline), /Unsafe candidate file path/)
  assert.equal(await readFile(join(external, 'outside.txt'), 'utf8'), 'external')
})

test('represents empty changes and safely applies a case-only filename rename', async t => {
  const { source, candidate } = await fixture(t)
  await writeFile(join(source, 'note.txt'), 'unchanged')
  const baseline = await createCandidateMirror(source, candidate)
  assert.equal((await collectCandidateChanges(baseline)).count, 0)
  await rename(join(candidate, 'note.txt'), join(candidate, 'renaming'))
  await rename(join(candidate, 'renaming'), join(candidate, 'Note.txt'))
  const plan = await collectCandidateChanges(baseline)
  assert.equal(plan.count, 1)
  assert.match(plan.diff, /Rename note\.txt → Note\.txt/)
  await applyCandidateChanges(plan)
  assert.deepEqual(await readdir(source), ['Note.txt'])
  assert.equal(await readFile(join(source, 'Note.txt'), 'utf8'), 'unchanged')
})
