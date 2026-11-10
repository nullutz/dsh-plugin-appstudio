import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { list } from 'tar'
import { projectArchive } from '../src/project/source.ts'

test('stages source without build output, dependencies or the Windows SDK path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appstudio-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['android', 'build', 'NODE_MODULES']) await mkdir(join(root, dir))
  await writeFile(join(root, 'pubspec.yaml'), 'fixture')
  await writeFile(join(root, 'android/local.properties'), 'sdk.dir=C:\\sdk')
  await writeFile(join(root, 'build/output.apk'), 'output')
  await writeFile(join(root, 'NODE_MODULES/package.json'), '{}')
  const entries: string[] = []
  const archive = list({ onReadEntry: entry => { entries.push(entry.path) } })
  for await (const chunk of projectArchive(root)) archive.write(Buffer.from(chunk))
  archive.end()
  assert.deepEqual(entries.sort(), ['./', './android/', './pubspec.yaml'])
})

test('rejects a junction without traversing the target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appstudio-link-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const target = join(root, 'outside')
  await mkdir(source)
  await mkdir(target)
  await writeFile(join(target, 'outside.txt'), 'should never be staged')
  await symlink(target, join(source, 'outside'), 'junction')
  await assert.rejects(async () => {
    for await (const chunk of projectArchive(source)) assert(!Buffer.from(chunk).includes('outside.txt'))
  }, /symbolic link: outside/)
})
