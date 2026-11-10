import { cp, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'

const root = fileURLToPath(new URL('../', import.meta.url))
const declarations = new URL('../packages/.typert-protocol/', import.meta.url)
const resolveProtocol = createRequire(new URL('../packages/appstudio/package.json', import.meta.url))
const published = resolveProtocol.resolve('@deepseek-ai/dsh-typert-protocol/types')
// Typert recognizes decorators from the protocol's registered workspace project.
// Register the pinned published declarations for analysis. Runtime imports still resolve from npm.
await mkdir(declarations, { recursive: true })
await cp(dirname(published), declarations, {
  recursive: true,
  filter: (path) => path === dirname(published) || path.endsWith('.d.ts'),
})
await writeFile(new URL('package.json', declarations), JSON.stringify({
  name: '@deepseek-ai/dsh-typert-protocol',
  type: 'module',
  exports: { '.': './index.d.ts', './types': './types.d.ts' },
}))
await writeFile(new URL('tsconfig.json', declarations), JSON.stringify({
  extends: '../../tsconfig.base.json',
  include: ['*.d.ts'],
}))
const artifacts = new WorkspaceTypertGenerator(root, { checkDiagnostics: false }).generateContributors(['host'])
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Expected the App Studio Host Remote artifact')
writeWorkspaceArtifacts(root, artifacts)
