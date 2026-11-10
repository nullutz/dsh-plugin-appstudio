import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FrameworkId, StarterLayout } from '../shared/protocol.ts'

export interface ScaffoldRequest {
  framework: FrameworkId
  root: string
  brief: { title?: string; layout?: StarterLayout | null }
  batchId: string
}

export interface ScaffoldFiles {
  editableEntry: string
  editableRoots: readonly string[]
  scenePaths: readonly string[]
}

export type ScaffoldProject = (request: ScaffoldRequest, signal?: AbortSignal) => Promise<ScaffoldFiles>

const java = 'app/src/main/java/dev/appstudio/starter'
const javaScene = `${java}/SceneStore.java`
const targets = {
  android: {
    androidDir: '',
    editableEntry: `${java}/MainActivity.java`,
    editableRoots: [java],
    scenePaths: [javaScene],
  },
  flutter: {
    androidDir: 'android/',
    editableEntry: 'lib/main.dart',
    editableRoots: ['lib'],
    scenePaths: [`android/${javaScene}`, 'android/app/src/main/kotlin/dev/appstudio/starter/MainActivity.kt', 'lib/app_studio_scene.dart'],
  },
  'react-native': {
    androidDir: 'android/',
    editableEntry: 'App.tsx',
    editableRoots: ['src'],
    scenePaths: [`android/${javaScene}`, `android/${java}/MainApplication.kt`, `android/${java}/ReactScenePackage.java`, 'src/app-studio-scene.ts'],
  },
} as const satisfies Record<FrameworkId, ScaffoldFiles & { androidDir: string }>

function defaultLayout(title: string): StarterLayout {
  return { screens: [
    { id: 'home', title: 'Overview', blocks: [
      { id: 'welcome', kind: 'heading', text: title },
      { id: 'intro', kind: 'text', text: 'Use this space to start your workflow.' },
      { id: 'open', kind: 'button', text: 'Open details' },
    ] },
    { id: 'details', title: 'Details', blocks: [
      { id: 'note', kind: 'input', text: 'Draft note' },
      { id: 'items', kind: 'list', text: Array.from({ length: 24 }, (_, index) => `Item ${index + 1}`).join('\n') },
    ] },
  ] }
}

function dartLiteral(value: string): string {
  return JSON.stringify(value).replaceAll('$', '\\$')
}

function javaLiteral(value: string): string {
  // Keep each literal below the class file's UTF-8 constant size limit.
  const chunks = value.match(/[\s\S]{1,8000}/g) ?? ['']
  if (chunks.length === 1) return JSON.stringify(chunks[0])
  return `String.join("",\n        ${chunks.map(chunk => JSON.stringify(chunk)).join(',\n        ')})`
}

function androidString(title: string): string {
  const value = title.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll("'", "\\'")
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<resources>\n    <string name="app_name" formatted="false">"${value}"</string>\n</resources>\n`
}

function gradleProperties(framework: FrameworkId): string {
  const distribution = framework === 'react-native' ? '9.4.1-bin' : '9.3.1-all'
  const checksum = framework === 'react-native'
    ? '2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb'
    : '17f277867f6914d61b1aa02efab1ba7bb439ad652ca485cd8ca6842fccec6e43'
  return `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${distribution}.zip
distributionSha256Sum=${checksum}
networkTimeout=30000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`
}

const ignores = `/.gradle/
/.dart_tool/
/.flutter-plugins-dependencies
/.idea/
/build/
/node_modules/
/android/.gradle/
/android/build/
/android/local.properties
/android/app/build/
/app/build/
/local.properties
`

async function* templates(directory: URL, relative = ''): AsyncIterable<{ source: URL; name: string }> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = relative + entry.name
    const source = new URL(encodeURIComponent(entry.name), directory)
    if (entry.isDirectory()) yield* templates(new URL(source.href + '/'), name + '/')
    else if (entry.isFile()) yield { source, name }
    else throw new Error(`Unsupported starter template entry: ${name}`)
  }
}

/** Materialize a pinned starter inside the caller's private generation candidate. */
export function createScaffolder(assets: URL): ScaffoldProject {
  return async ({ framework, root, brief, batchId }, signal) => {
    signal?.throwIfAborted()
    const target = targets[framework]
    const android = target.androidDir
    const title = brief.title?.trim() || 'App Studio App'
    const layout = brief.layout ?? defaultLayout(title)
    if (!layout.screens.length) throw new Error('Add at least one screen to the starter layout.')
    const design = JSON.stringify(layout.screens)
    const hash = createHash('sha256').update(batchId).digest('hex').slice(0, 16)
    const variables = {
      APP_ID: `dev.appstudio.generated.a${hash}`,
      TITLE_DART: dartLiteral(title),
      TITLE_JS: JSON.stringify(title),
      TITLE_JAVA: javaLiteral(title),
      DESIGN_DART: dartLiteral(design),
      DESIGN_JAVA: javaLiteral(design),
      DESIGN_JS: design,
    }
    async function write(path: string, content: string | Uint8Array, mode?: number): Promise<void> {
      signal?.throwIfAborted()
      const destination = join(root, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content, { flag: 'wx', mode, signal })
    }
    for await (const { source, name } of templates(new URL(framework + '/', assets))) {
      const filename = name === 'npm-lock.json' ? 'package-lock.json'
        : name === 'npm-package.json' ? 'package.json' : name
      const content = (await readFile(source, 'utf8')).replace(/__(APP_ID|TITLE_(?:DART|JAVA|JS)|DESIGN_(?:DART|JAVA|JS))__/g,
        (_, key: keyof typeof variables) => variables[key])
      await write(filename, content)
    }
    const common = {
      gradlew: `${android}gradlew`,
      'gradlew.bat': `${android}gradlew.bat`,
      'gradle-wrapper.jar': `${android}gradle/wrapper/gradle-wrapper.jar`,
      'GRADLE-LICENSE': 'GRADLE-LICENSE',
      'SceneStore.java': `${android}${javaScene}`,
    }
    for (const [name, path] of Object.entries(common)) {
      await write(path, await readFile(new URL(`common/${name}`, assets)), name === 'gradlew' ? 0o755 : undefined)
    }
    await write(`${android}gradle/wrapper/gradle-wrapper.properties`, gradleProperties(framework))
    await write(`${android}app/src/main/res/values/app_name.xml`, androidString(title))
    await write('.gitignore', ignores)
    await write('.gitattributes', 'gradlew text eol=lf\ngradlew.bat text eol=crlf\n')
    return { editableEntry: target.editableEntry, editableRoots: target.editableRoots, scenePaths: target.scenePaths }
  }
}
