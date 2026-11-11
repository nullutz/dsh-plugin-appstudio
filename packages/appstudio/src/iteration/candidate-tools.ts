import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { candidatePathEditable, type CandidateEditScope } from './candidate-scope.ts'

export interface CandidateLease {
  root: string
  batchId: string
  editScope?: CandidateEditScope
}

const fileLimit = 512 * 1024
const renderedLimit = 48 * 1024
const ignored = new Set(['.git', '.hg', '.svn', 'node_modules', '.gradle', '.dart_tool'])
const credentialNames = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.npmrc', '.netrc',
  '.pypirc', '.credentials.yaml', '.credentials.yml', 'key.properties'])
const dotenvTemplate = /^\.env\.(?:example|sample|template)$/u
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
export const candidateToolNames: ReadonlySet<string> = new Set([
  'appstudio_list_files', 'appstudio_read_file', 'appstudio_edit_file', 'appstudio_write_file', 'appstudio_delete_file',
])

function within(parent: string, path: string): boolean {
  const child = relative(parent, path)
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

function localCredential(name: string): boolean {
  const key = name.toLowerCase()
  return credentialNames.has(key) || (key === '.env' || key.startsWith('.env.') && !dotenvTemplate.test(key)) ||
    /\.(?:key|jks|keystore|p12|pfx)$/u.test(key)
}

function pathParts(path: string): string[] {
  const parts = path.split('/')
  if (path.length > 1024 || parts.some(part => !part || part === '.' || part === '..' ||
      /[<>:"\\|?*\x00-\x1f]/u.test(part) || /[. ]$/.test(part) ||
      reservedWindowsName.test(part) || ignored.has(part.toLowerCase()))) {
    throw new Error('Use a normal, project-relative candidate path with forward slashes.')
  }
  if (parts.some(localCredential)) throw new Error('Local credential files are outside the App Studio candidate tool scope.')
  return parts
}

async function statIfExists(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function checkTextLimit(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > fileLimit || text.includes('\0')) {
    throw new Error('Candidate text files must be at most 512 KiB and contain no NUL bytes.')
  }
}

/** Candidate-only filesystem access with a fresh Host authorization for every tool call. */
export class CandidateFiles {
  private readonly sourceRoot: string
  private readonly authorize: () => CandidateLease | undefined

  constructor(sourceRoot: string, authorize: () => CandidateLease | undefined) {
    this.sourceRoot = sourceRoot
    this.authorize = authorize
  }

  private async root(signal: AbortSignal): Promise<{ path: string, lease: CandidateLease }> {
    signal.throwIfAborted()
    const lease = this.authorize()
    if (!lease || !isAbsolute(lease.root) || !(await lstat(lease.root)).isDirectory()) {
      throw new Error('No App Studio candidate is authorized for this turn.')
    }
    const [path, source] = await Promise.all([realpath(lease.root), realpath(this.sourceRoot)])
    if (within(path, source) || within(source, path)) {
      throw new Error('The candidate must be separate from the project source.')
    }
    return { path, lease }
  }

  private assertActive(lease: CandidateLease, signal: AbortSignal): void {
    signal.throwIfAborted()
    const current = this.authorize()
    if (!current || current.batchId !== lease.batchId || current.root !== lease.root) {
      throw new Error('This App Studio candidate authorization expired.')
    }
  }

  private editablePath(path: string, lease: CandidateLease): string[] {
    const parts = pathParts(path)
    if (lease.editScope && !candidatePathEditable(path, lease.editScope)) {
      throw new Error('Generation edits must stay in the allowed application source and asset paths. The starter build and scene bridge are protected.')
    }
    return parts
  }

  private async target(root: string, parts: string[], kind: 'directory' | 'file' | 'new', signal: AbortSignal): Promise<string> {
    let path = root
    for (const [index, part] of parts.entries()) {
      signal.throwIfAborted()
      path = join(path, part)
      const last = index === parts.length - 1
      const info = await statIfExists(path)
      if (info?.isSymbolicLink()) throw new Error('Candidate symbolic links are unavailable.')
      if (last && kind === 'new') {
        if (info) throw new Error('This candidate file already exists. Use appstudio_edit_file to change it.')
        return path
      }
      if (!last || kind === 'directory') {
        if (!info?.isDirectory()) throw new Error('Candidate directory was not found.')
      } else if (!info?.isFile() || info.nlink !== 1 || info.size > fileLimit) {
        throw new Error('Candidate file was not found or is outside the supported text-file limits.')
      }
      if (!within(root, await realpath(path))) throw new Error('Candidate paths must stay inside the authorized copy.')
    }
    return path
  }

  private async text(path: string, signal: AbortSignal): Promise<string> {
    const contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path, { signal }))
    checkTextLimit(contents)
    return contents
  }

  async list(path: string, signal: AbortSignal): Promise<string> {
    const root = await this.root(signal)
    const folder = await this.target(root.path, path === '' ? [] : pathParts(path), 'directory', signal)
    const entries = (await readdir(folder, { withFileTypes: true }))
      .filter(entry => !ignored.has(entry.name.toLowerCase()) && !localCredential(entry.name) && (entry.isDirectory() || entry.isFile()))
      .sort((left, right) => left.name.localeCompare(right.name))
    const visible = entries.slice(0, 200).map(entry => entry.name + (entry.isDirectory() ? '/' : ''))
    if (entries.length > visible.length) visible.push(`… ${entries.length - visible.length} more entries`)
    return visible.join('\n').slice(0, renderedLimit) || '(empty directory)'
  }

  async read(path: string, start: number, count: number, signal: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 500) {
      throw new Error('Use a 1-based starting line and read 1–500 lines.')
    }
    const root = await this.root(signal)
    const lines = (await this.text(await this.target(root.path, pathParts(path), 'file', signal), signal)).split(/\r?\n/)
    if (start > lines.length) throw new Error(`The file has ${lines.length} lines.`)
    const visible = lines.slice(start - 1, start + count - 1).join('\n')
    return `${path} (${lines.length} total lines, starting at ${start})\n${visible.slice(0, renderedLimit)}` +
      (visible.length > renderedLimit ? '\n… Use a smaller line range for the remainder.' : '')
  }

  async edit(path: string, oldText: string, newText: string, signal: AbortSignal): Promise<string> {
    if (!oldText) throw new Error('Provide nonempty existing text to replace.')
    const root = await this.root(signal)
    const target = await this.target(root.path, this.editablePath(path, root.lease), 'file', signal)
    const before = await this.text(target, signal)
    // Reads normalize line separators for display. Match multiline snippets on CRLF files too.
    const windowsLines = before.includes('\r\n') && !before.replaceAll('\r\n', '').includes('\n')
    const match = windowsLines ? oldText.replace(/\r?\n/g, '\r\n') : oldText
    const replacement = windowsLines ? newText.replace(/\r?\n/g, '\r\n') : newText
    const index = before.indexOf(match)
    if (index < 0 || before.indexOf(match, index + 1) >= 0) {
      throw new Error('Existing text must occur exactly once. Read the file and provide more surrounding context.')
    }
    const after = before.slice(0, index) + replacement + before.slice(index + match.length)
    checkTextLimit(after)
    const temp = join(dirname(target), `.appstudio-edit-${randomUUID()}.tmp`)
    try {
      await writeFile(temp, after, { encoding: 'utf8', flag: 'wx', signal })
      this.assertActive(root.lease, signal)
      await rename(temp, target)
    } finally {
      await unlink(temp).catch(() => {})
    }
    return `Updated ${path}`
  }

  async write(path: string, text: string, signal: AbortSignal): Promise<string> {
    checkTextLimit(text)
    const root = await this.root(signal)
    const parts = this.editablePath(path, root.lease)
    let directory = root.path
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part)
      this.assertActive(root.lease, signal)
      const info = await statIfExists(directory)
      if (!info) await mkdir(directory)
      else if (!info.isDirectory()) throw new Error('Candidate parents must be ordinary directories.')
      if (!within(root.path, await realpath(directory))) throw new Error('Candidate paths must stay inside the authorized copy.')
    }
    const target = await this.target(root.path, parts, 'new', signal)
    this.assertActive(root.lease, signal)
    // Open with exclusive creation. After admission the write runs to completion to avoid a canceled partial file.
    await writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
    return `Created ${path}`
  }

  async delete(path: string, signal: AbortSignal): Promise<string> {
    const root = await this.root(signal)
    const target = await this.target(root.path, this.editablePath(path, root.lease), 'file', signal)
    await this.text(target, signal)
    this.assertActive(root.lease, signal)
    await unlink(target)
    return `Deleted ${path}`
  }
}

/** Mount only the narrow candidate text-file capabilities of the App Studio preset. */
export function registerCandidateTools(ctx: Context, candidate: CandidateFiles, active: () => boolean): (() => void)[] {
  const path = { type: 'string', required: true, description: 'Project-relative candidate path using forward slashes.' } as const
  const output = {
    schema: { type: 'string' },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  } as const
  const options = { when: active }
  return [
    ctx.tools.register(defineTool({
      name: 'appstudio_list_files', description: 'List files and directories in the authorized candidate. Use an empty path for its root.',
      parameters: { path }, output,
      async execute(args, exec) { return await candidate.list(args.path, exec.signal) },
    }), options),
    ctx.tools.register(defineTool({
      name: 'appstudio_read_file', description: 'Read a range of lines from a candidate UTF-8 source file.',
      parameters: {
        path, start: { type: 'integer', required: true, description: 'First line to read (1-based).' },
        count: { type: 'integer', required: true, description: 'Number of lines to read (1–500).' },
      }, output,
      async execute(args, exec) { return await candidate.read(args.path, args.start, args.count, exec.signal) },
    }), options),
    ctx.tools.register(defineTool({
      name: 'appstudio_edit_file', description: 'Replace one unique text span in an existing candidate file.',
      parameters: {
        path, oldText: { type: 'string', required: true, description: 'Exact existing text, occurring once.' },
        newText: { type: 'string', required: true, description: 'Replacement text.' },
      }, output,
      async execute(args, exec) { return await candidate.edit(args.path, args.oldText, args.newText, exec.signal) },
    }), options),
    ctx.tools.register(defineTool({
      name: 'appstudio_write_file', description: 'Create a new UTF-8 file in the candidate.',
      parameters: { path, text: { type: 'string', required: true, description: 'Complete file contents.' } }, output,
      async execute(args, exec) { return await candidate.write(args.path, args.text, exec.signal) },
    }), options),
    ctx.tools.register(defineTool({
      name: 'appstudio_delete_file', description: 'Delete one existing UTF-8 file in the candidate.',
      parameters: { path }, output,
      async execute(args, exec) { return await candidate.delete(args.path, exec.signal) },
    }), options),
  ]
}
