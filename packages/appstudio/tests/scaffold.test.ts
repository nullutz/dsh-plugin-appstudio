import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createScaffolder } from '../src/generation/scaffold.ts'
import type { FrameworkId, StarterLayout } from '../src/shared/protocol.ts'

const scaffold = createScaffolder(new URL('../scaffold/', import.meta.url))
const title = 'Notes "$studio" & O\'Brien 测试'
const layout: StarterLayout = { screens: [
  { id: 'today', title: 'Today', blocks: [
    { id: 'title', kind: 'heading', text: 'Schedule __APP_ID__' },
    { id: 'next', kind: 'button', text: 'Open archive', position: { row: 2, column: 8, span: 4 } },
    { id: 'draft', kind: 'input', text: 'Write a draft', position: { row: 2, column: 1, span: 6 } },
  ] },
  { id: 'archive', title: 'Archive', blocks: [{ id: 'items', kind: 'list', text: 'One\nTwo' }] },
] }

for (const framework of ['android', 'flutter', 'react-native'] as const satisfies readonly FrameworkId[]) {
  test(`generates pinned ${framework} sources with the requested layout and protected scene files`, async context => {
    const root = await mkdtemp(join(tmpdir(), 'appstudio-starter-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const request = { framework, root, brief: { title, layout }, batchId: 'local-batch-one' }
    const files = await scaffold(request)
    const android = framework === 'android' ? root : join(root, 'android')
    const entry = await readFile(join(root, files.editableEntry), 'utf8')
    assert.match(entry, /Schedule __APP_ID__/)
    assert.match(entry, /Write a draft/)
    assert.match(entry, /Open archive/)
    assert.match(entry, /Archive/)
    assert.match(entry, /测试/)
    assert.doesNotMatch(entry, /__DESIGN_\w+__|__TITLE_\w+__/)
    const designLiteral = entry.match(/^(?:const _design|\s*private static final String DESIGN|const screens: Screen\[\]) = (.+);$/m)?.[1]
    assert(designLiteral)
    const design = JSON.parse(framework === 'react-native' ? designLiteral : JSON.parse(designLiteral))
    assert.deepEqual(design, [
      { id: 'today', title: 'Today', rows: [
        { spaceBefore: 12, cells: [{ span: 12, block: { id: 'title', kind: 'heading', text: 'Schedule __APP_ID__' } }] },
        { spaceBefore: 48, cells: [
          { span: 1 },
          { span: 6, block: { id: 'draft', kind: 'input', text: 'Write a draft' } },
          { span: 1 },
          { span: 4, block: { id: 'next', kind: 'button', text: 'Open archive' } },
        ] },
      ] },
      { id: 'archive', title: 'Archive', rows: [
        { spaceBefore: 12, cells: [{ span: 12, block: { id: 'items', kind: 'list', text: 'One\nTwo' } }] },
      ] },
    ])
    assert.equal(files.scenePaths.includes(files.editableEntry), false)
    for (const path of files.scenePaths) assert((await readFile(join(root, path))).length > 0)

    const gradle = await readFile(join(android, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8')
    assert.match(gradle, /^distributionSha256Sum=[a-f0-9]{64}$/m)
    const attributes = await readFile(join(root, '.gitattributes'), 'utf8')
    assert.match(attributes, /^gradlew text eol=lf$/m)
    assert.match(attributes, /^gradlew\.bat text eol=crlf$/m)
    assert.doesNotMatch(await readFile(join(android, 'gradlew'), 'utf8'), /\r/)
    const jar = await readFile(join(android, 'gradle', 'wrapper', 'gradle-wrapper.jar'))
    assert.equal(createHash('sha256').update(jar).digest('hex'), '55243ef57851f12b070ad14f7f5bb8302daceeebc5bce5ece5fa6edb23e1145c')
    const build = await readFile(join(android, 'app', framework === 'flutter' ? 'build.gradle.kts' : 'build.gradle'), 'utf8')
    assert.match(build, /dev\.appstudio\.generated\.a[a-f0-9]{16}/)
    const label = await readFile(join(android, 'app', 'src', 'main', 'res', 'values', 'app_name.xml'), 'utf8')
    assert.match(label, /&amp;/)
    if (framework === 'react-native') {
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
      assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies)
      assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies)
      assert.equal(lock.packages['node_modules/react-native'].version, '0.88.1')
    }

    await assert.rejects(scaffold(request), /EEXIST/)
    assert.equal(await readFile(join(root, files.editableEntry), 'utf8'), entry)
  })
}

test('an aborted generation leaves its private scaffold directory empty', async context => {
  const root = await mkdtemp(join(tmpdir(), 'appstudio-starter-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const signal = AbortSignal.abort()
  await assert.rejects(scaffold({ framework: 'flutter', root, brief: {}, batchId: 'aborted' }, signal), { name: 'AbortError' })
  assert.deepEqual(await readdir(root), [])
})
