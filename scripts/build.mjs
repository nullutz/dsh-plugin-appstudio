import { cp, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkg = fileURLToPath(new URL('../packages/appstudio/', import.meta.url))
const runtime = new URL('../packages/appstudio/lib/runtime/', import.meta.url)
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
execFileSync(process.execPath, [
  compiler, '-p', 'tsconfig.host.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly',
  '--rootDir', 'src', '--outDir', 'lib/types', '--rewriteRelativeImportExtensions',
], { cwd: pkg, stdio: 'inherit' })

await Promise.all([
  build({
    absWorkingDir: pkg,
    entryPoints: {
      host: 'src/host/index.ts', android: 'src/host/android.ts', flutter: 'src/host/flutter.ts',
      'react-native': 'src/host/react-native.ts', 'native-android': 'src/host/native-android.ts',
      commenting: 'src/host/commenting.ts', agent: 'src/host/agent.ts', iterations: 'src/host/iterations.ts',
      layout: 'src/host/layout.ts', prompt: 'src/host/prompt.ts',
      'iteration-host': 'src/iteration/service.ts',
    },
    outdir: 'lib', bundle: true, packages: 'external',
    tsconfig: 'tsconfig.host.json', platform: 'node', format: 'esm', target: 'node24',
  }),
  build({
    absWorkingDir: pkg,
    entryPoints: ['src/client/index.tsx'],
    outfile: 'lib/client.js', bundle: true,
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'zod'],
    tsconfig: 'tsconfig.client.json', platform: 'browser', format: 'cjs', target: 'chrome152',
    banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-plugin-appstudio", factory(require) { const module = { exports: {} }; let exports = module.exports;' },
    footer: { js: 'return module.exports; } });' },
  }),
  (async () => {
    await mkdir(runtime, { recursive: true })
    await cp(new URL('../packages/appstudio/runtime/', import.meta.url), runtime, {
      recursive: true,
      filter: (source) => !source.endsWith('__pycache__'),
    })
    await cp(new URL('../runtime-lock.json', import.meta.url), new URL('runtime-lock.json', runtime))
  })(),
])
