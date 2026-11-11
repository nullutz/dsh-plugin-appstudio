import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const packageManifest = new URL('../packages/appstudio/package.json', import.meta.url)
const manifest = JSON.parse(await readFile(packageManifest, 'utf8'))
const { list } = createRequire(packageManifest)('tar')
const file = process.argv[2]
if (!file || process.argv.length !== 3) {
  console.error('Usage: pnpm verify:package <appstudio.tgz>')
  process.exit(2)
}

const declarationGlob = 'lib/types/**/*.d.ts'
const declarations = /^lib\/types\/(?:[\w.-]+\/)*[\w.-]+\.d\.ts$/
const docs = /^(?:README|LICEN[CS]E|NOTICE)(?:\.[\w.-]+)?$/i
const declared = new Set(manifest.files.filter(path => path !== declarationGlob))
const required = new Set([...declared, 'package.json'])
for (const value of Object.values(manifest.exports)) {
  if (typeof value === 'string') required.add(value.slice(2))
  else for (const path of Object.values(value)) required.add(path.slice(2))
}

const sensitive = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})\b/],
  ['API credential', /\b(?:sk-[A-Za-z0-9_-]{28,}|AKIA[A-Z0-9]{16})\b/],
  ['credential-bearing URL', /https?:\/\/[^\/\s@"<>]+:[^\/\s@"<>]+@[^\/\s"<>]+/],
  ['local filesystem path', /[A-Z]:[\\/]+(?:Users|GitRepo|AppData)[\\/]|\/(?:home|mnt\/[a-z])\/[a-z][a-z0-9_.-]+\b/i],
  ['isolated test runtime', /DSH-AppStudio-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|\.validation[\\/]/i],
]
const errors = []
const seen = new Set()
const maxFileBytes = 16 * 1024 * 1024
const safeLabel = path => /^[\w./-]{1,240}$/.test(path) && !sensitive.some(([, rule]) => rule.test(path))
  ? path : '<redacted archive path>'

await list({
  file: resolve(file),
  strict: true,
  onReadEntry(entry) {
    const path = entry.path.startsWith('package/') ? entry.path.slice('package/'.length) : ''
    const label = safeLabel(path || entry.path)
    const isDeclaration = manifest.files.includes(declarationGlob) && declarations.test(path)
    if (entry.type !== 'File' || !path || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
        (!declared.has(path) && path !== 'package.json' && !docs.test(path) && !isDeclaration)) {
      errors.push('Unexpected archive entry: ' + label)
      return
    }
    if (seen.has(path)) {
      errors.push('Duplicate archive entry: ' + label)
      return
    }
    seen.add(path)
    if (entry.size > maxFileBytes) {
      errors.push('Archive entry exceeds scan limit: ' + label)
      return
    }
    const chunks = []
    entry.on('data', chunk => chunks.push(chunk))
    entry.on('end', () => {
      const bytes = Buffer.concat(chunks)
      if (path === 'scaffold/common/gradle-wrapper.jar') return
      if (bytes.includes(0)) {
        errors.push('Unexpected binary contents: ' + label)
        return
      }
      const contents = bytes.toString('utf8')
      for (const [description, rule] of sensitive) {
        if (rule.test(contents)) errors.push(description + ': ' + label)
      }
      if (path === 'package.json') {
        try {
          const packed = JSON.parse(contents)
          if (packed.name !== manifest.name || packed.version !== manifest.version) errors.push('Package identity does not match the source manifest.')
        } catch {
          errors.push('The packaged manifest is invalid.')
        }
      }
    })
  },
}).catch(() => { errors.push('The archive could not be read.') })

for (const path of required) if (!seen.has(path)) errors.push('Missing archive entry: ' + safeLabel(path))
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('Verified ' + seen.size + ' package files for ' + manifest.name + '@' + manifest.version + '.')
}
