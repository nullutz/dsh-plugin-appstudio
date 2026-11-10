import { createHash } from 'node:crypto'
import {
  constants, linkSync, lstatSync, mkdirSync, readdirSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, type Stats,
} from 'node:fs'
import { open, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { projectSourceIncluded } from '../project/source.ts'

export interface CandidateFile {
  path: string
  sha256: string
  size: number
  mode: number
}

/** Serializable evidence of the source copied into one editable candidate. */
export interface CandidateBaseline {
  sourceRoot: string
  candidateRoot: string
  files: CandidateFile[]
}

export interface CandidateChanges {
  baseline: CandidateBaseline
  candidateFiles: CandidateFile[]
  count: number
  diff: string
}

interface ScannedFile {
  file: CandidateFile
  stat: Stats
  copyStat?: Stats
}

interface Change {
  before?: CandidateFile
  after?: CandidateFile
}

const treeLimit = 1024 * 1024 * 1024
const fileCountLimit = 100_000
const previewFileLimit = 128 * 1024
const previewLimit = 200_000
const transactionName = '.appstudio-apply-lock'
const reserved = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

function pathParts(path: string): string[] {
  const parts = path.split('/')
  if (path.length > 4096 || parts.some(part => !part || part === '.' || part === '..' ||
    /[<>:"\\|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || reserved.test(part))) {
    throw new Error('Unsafe candidate file path: ' + JSON.stringify(path))
  }
  return parts
}

function checkedRoot(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
    throw new Error('Candidate and project roots must be canonical directories.')
  }
  return path
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
}

function separateRoots(sourceRoot: string, candidateRoot: string): void {
  if (contains(sourceRoot, candidateRoot) || contains(candidateRoot, sourceRoot)) {
    throw new Error('The candidate must be outside the original project.')
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function optionalStat(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (!missing(error)) throw error
    return undefined
  }
}

/** Resolve a file without following a directory symlink or junction. */
function filePath(root: string, path: string, makeDirectory?: (path: string) => void): string {
  const parts = pathParts(path)
  let current = root
  for (const name of parts.slice(0, -1)) {
    current = join(current, name)
    const info = optionalStat(current)
    if (!info && makeDirectory) makeDirectory(current)
    else if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe candidate parent directory: ' + path)
  }
  return join(current, parts.at(-1)!)
}

function sameStat(left: Stats, right: Stats, ignoreCtime = false, extraLinks = 0): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.nlink + extraLinks === right.nlink && left.mode === right.mode && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && (ignoreCtime || left.ctimeMs === right.ctimeMs)
}

async function inspectFile(root: string, path: string, signal?: AbortSignal, copyTo?: string): Promise<ScannedFile> {
  const source = filePath(root, path)
  const before = lstatSync(source)
  if (!before.isFile() || before.nlink !== 1 || before.size > treeLimit) {
    throw new Error('Expected a regular, unlinked project file under 1 GiB: ' + path)
  }
  const handle = await open(source, readFlags)
  try {
    if (!sameStat(before, await handle.stat())) throw new Error('Project file changed while opening: ' + path)
    const hash = createHash('sha256')
    let bytes = 0
    let copyStat: Stats | undefined
    const output = copyTo ? await open(copyTo, 'wx', before.mode & 0o777) : undefined
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        bytes += chunk.length
        if (bytes > before.size) throw new Error('Project file changed while reading: ' + path)
        hash.update(chunk)
        if (output) {
          let written = 0
          while (written < chunk.length) {
            const { bytesWritten } = await output.write(chunk, written, chunk.length - written, null)
            if (!bytesWritten) throw new Error('Could not write project file copy: ' + path)
            written += bytesWritten
          }
        }
      }
      if (output && copyTo) {
        await output.chmod(before.mode & 0o777)
        copyStat = await output.stat()
        if (!sameStat(copyStat, lstatSync(copyTo))) throw new Error('The project file copy changed: ' + path)
      }
    } finally {
      await output?.close()
    }
    if (bytes !== before.size || !sameStat(before, await handle.stat()) ||
      !sameStat(before, lstatSync(filePath(root, path)))) {
      throw new Error('Project file changed while reading: ' + path)
    }
    return { file: { path, sha256: hash.digest('hex'), size: bytes, mode: before.mode & 0o777 }, stat: before, copyStat }
  } finally {
    await handle.close()
  }
}

async function scan(root: string, signal?: AbortSignal, mirror?: string): Promise<Map<string, ScannedFile>> {
  const pending = ['']
  const names = new Set<string>()
  const files = new Map<string, ScannedFile>()
  let bytes = 0
  while (pending.length) {
    signal?.throwIfAborted()
    const directory = pending.pop()!
    const absolute = directory ? filePath(root, directory) : root
    if (!lstatSync(absolute).isDirectory()) throw new Error('A project directory changed while scanning: ' + directory)
    for (const name of readdirSync(absolute).sort()) {
      signal?.throwIfAborted()
      const path = directory ? directory + '/' + name : name
      if (!projectSourceIncluded(path)) continue
      pathParts(path)
      const key = path.toLowerCase()
      if (names.has(key)) throw new Error('The project contains case-colliding paths: ' + path)
      names.add(key)
      if (names.size > fileCountLimit) throw new Error('The project contains too many source paths.')
      const entry = lstatSync(filePath(root, path))
      if (entry.isDirectory()) {
        if (mirror) mkdirSync(filePath(mirror, path), { mode: 0o700 })
        pending.push(path)
      } else {
        if (bytes + entry.size > treeLimit) throw new Error('The project source snapshot exceeds 1 GiB.')
        const result = await inspectFile(root, path, signal, mirror && filePath(mirror, path))
        bytes += result.file.size
        if (bytes > treeLimit) throw new Error('The project source snapshot exceeds 1 GiB.')
        files.set(key, result)
      }
    }
  }
  return files
}

function manifest(files: readonly CandidateFile[]): Map<string, CandidateFile> {
  const result = new Map<string, CandidateFile>()
  let bytes = 0
  if (!Array.isArray(files) || files.length > fileCountLimit) throw new Error('Invalid candidate file manifest.')
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 ||
      !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
      !projectSourceIncluded(file.path)) throw new Error('Invalid candidate file manifest entry.')
    pathParts(file.path)
    const key = file.path.toLowerCase()
    if (result.has(key)) throw new Error('Duplicate candidate file manifest path: ' + file.path)
    bytes += file.size
    if (bytes > treeLimit) throw new Error('The project source snapshot exceeds 1 GiB.')
    result.set(key, file)
  }
  return result
}

function sameFile(before: CandidateFile | undefined, after: CandidateFile | undefined): boolean {
  return before?.path === after?.path && before?.sha256 === after?.sha256 &&
    before?.size === after?.size && before?.mode === after?.mode
}

function assertTree(expected: Map<string, CandidateFile>, actual: Map<string, ScannedFile>, message: string): void {
  for (const [key, file] of expected) {
    if (!sameFile(file, actual.get(key)?.file)) throw new Error(message + ': ' + file.path)
  }
  for (const [key, file] of actual) {
    if (!expected.has(key)) throw new Error(message + ': ' + file.file.path)
  }
}

function entries(before: Map<string, CandidateFile>, after: Map<string, CandidateFile>): Change[] {
  const oldParents = new Map<string, string>()
  for (const { path } of before.values()) {
    const parts = pathParts(path)
    for (let end = 1; end < parts.length; end++) {
      const parent = parts.slice(0, end).join('/')
      oldParents.set(parent.toLowerCase(), parent)
    }
  }
  for (const { path } of after.values()) {
    const parts = pathParts(path)
    for (let end = 1; end < parts.length; end++) {
      const parent = parts.slice(0, end).join('/')
      const old = oldParents.get(parent.toLowerCase())
      if (old !== undefined && old !== parent) throw new Error('Case-only directory renames are unsupported: ' + old)
    }
  }
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(key => {
    const old = before.get(key)
    const next = after.get(key)
    return sameFile(old, next) ? [] : [{ before: old, after: next }]
  })
}

/** Clone included source and record exactly the bytes given to the Agent. */
export async function createCandidateMirror(sourceRoot: string, candidateRoot: string, signal?: AbortSignal): Promise<CandidateBaseline> {
  signal?.throwIfAborted()
  sourceRoot = checkedRoot(sourceRoot)
  if (!isAbsolute(candidateRoot) || resolve(candidateRoot) !== candidateRoot) throw new Error('Invalid candidate directory.')
  candidateRoot = join(checkedRoot(dirname(candidateRoot)), basename(candidateRoot))
  pathParts(basename(candidateRoot))
  separateRoots(sourceRoot, candidateRoot)
  mkdirSync(candidateRoot, { mode: 0o700 })
  try {
    const copies = await scan(sourceRoot, signal, candidateRoot)
    const files = [...copies.values()].map(({ file }) => file)
    return { sourceRoot, candidateRoot: checkedRoot(candidateRoot), files }
  } catch (error) {
    await rm(candidateRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
    throw error
  }
}

async function preview(root: string, file: CandidateFile | undefined): Promise<string | undefined> {
  if (!file) return ''
  const path = filePath(root, file.path)
  const before = lstatSync(path)
  if (!before.isFile() || before.nlink !== 1) throw new Error('Unsafe candidate file: ' + file.path)
  const handle = await open(path, readFlags)
  try {
    if (!sameStat(before, await handle.stat())) throw new Error('Project file changed while preparing its diff: ' + file.path)
    const buffer = Buffer.alloc(file.size + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const content = buffer.subarray(0, length)
    if (length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256 ||
      !sameStat(before, lstatSync(filePath(root, file.path)))) {
      throw new Error('Project file changed while preparing its diff: ' + file.path)
    }
    if (content.includes(0)) return undefined
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
    } catch {
      return undefined
    }
  } finally {
    await handle.close()
  }
}

function validateRoots(baseline: CandidateBaseline): void {
  checkedRoot(baseline.sourceRoot)
  checkedRoot(baseline.candidateRoot)
  separateRoots(baseline.sourceRoot, baseline.candidateRoot)
}

/** Produce a bounded diff against the still-current original snapshot. */
export async function collectCandidateChanges(baseline: CandidateBaseline, signal?: AbortSignal): Promise<CandidateChanges> {
  validateRoots(baseline)
  const original = manifest(baseline.files)
  assertTree(original, await scan(baseline.sourceRoot, signal), 'The project changed since this iteration started')
  const candidateFiles = [...(await scan(baseline.candidateRoot, signal)).values()].map(({ file }) => file)
  const changes = entries(original, manifest(candidateFiles))
  let diff = ''
  for (const { before, after } of changes) {
    signal?.throwIfAborted()
    const path = (after ?? before)!.path
    let part = ''
    if (before && after && before.path !== after.path) part += 'Rename ' + before.path + ' → ' + after.path + '\n'
    if (before && after && before.mode !== after.mode) {
      part += 'Mode changed for ' + path + ' (' + before.mode.toString(8) + ' → ' + after.mode.toString(8) + ')\n'
    }
    if (Math.max(before?.size ?? 0, after?.size ?? 0) > previewFileLimit) {
      part += 'Diff omitted for large file ' + path + '\n'
    } else {
      const oldText = await preview(baseline.sourceRoot, before)
      const newText = await preview(baseline.candidateRoot, after)
      if (oldText === undefined || newText === undefined) part += 'Binary file changed: ' + path + '\n'
      else if (oldText !== newText || !before || !after) {
        part += createTwoFilesPatch(before ? 'a/' + before.path : '/dev/null', after ? 'b/' + after.path : '/dev/null',
          oldText, newText, undefined, undefined, { context: 3, timeout: 100 }) ?? 'Diff exceeded its time limit: ' + path + '\n'
      }
    }
    if (diff.length + part.length > previewLimit) {
      diff += '[Diff preview truncated]\n'
      break
    }
    diff += part
  }
  return { baseline, candidateFiles, count: changes.length, diff }
}

/**
 * Publish only the verified delta. The source-volume journal keeps old files
 * until every exclusive install succeeds and retains them if rollback is blocked.
 */
export async function applyCandidateChanges(plan: CandidateChanges, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const { baseline } = plan
  validateRoots(baseline)
  const original = manifest(baseline.files)
  const candidate = manifest(plan.candidateFiles)
  const changes = entries(original, candidate)
  if (changes.length !== plan.count) throw new Error('Invalid candidate change count.')
  if (!changes.length) return
  if (process.platform === 'win32' && changes.some(({ before, after }) =>
    [before, after].some(file => file && (file.mode & 0o222) === 0))) {
    throw new Error('Windows cannot safely apply a change to a read-only project file.')
  }
  const journal = join(baseline.sourceRoot, transactionName)
  try {
    mkdirSync(journal, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A source apply is active or needs recovery at ' + journal, { cause: error })
    }
    throw error
  }
  const undo: Array<() => void> = []
  const stagedStats = new Map<number, Stats>()
  let preserve = false
  try {
    assertTree(candidate, await scan(baseline.candidateRoot, signal), 'The candidate changed after validation')
    for (const [index, change] of changes.entries()) {
      if (!change.after) continue
      const staged = await inspectFile(baseline.candidateRoot, change.after.path, signal, join(journal, 'new-' + index))
      if (!sameFile(change.after, staged.file)) throw new Error('The candidate changed after validation: ' + change.after.path)
      stagedStats.set(index, staged.copyStat!)
    }
    const current = await scan(baseline.sourceRoot, signal)
    assertTree(original, current, 'The project changed since this iteration started')
    await writeFile(join(journal, 'changes.json'), JSON.stringify(changes), { flag: 'wx' })
    signal?.throwIfAborted()
    validateRoots(baseline)
    checkedRoot(journal)
    for (const [index, change] of changes.entries()) {
      if (!change.before) continue
      const path = change.before.path
      const before = current.get(path.toLowerCase())!.stat
      const source = filePath(baseline.sourceRoot, path)
      if (!sameStat(before, lstatSync(source))) throw new Error('The project changed while applying: ' + path)
      const backup = join(journal, 'old-' + index)
      renameSync(source, backup)
      undo.push(() => linkSync(backup, filePath(baseline.sourceRoot, path)))
      if (!sameStat(before, lstatSync(backup), true)) throw new Error('The project changed while applying: ' + path)
    }
    for (const [index, change] of changes.entries()) {
      if (!change.after) continue
      const path = change.after.path
      const source = filePath(baseline.sourceRoot, path, directory => {
        mkdirSync(directory)
        undo.push(() => rmdirSync(directory))
      })
      const prior = optionalStat(source)
      if (prior?.isDirectory() && !prior.isSymbolicLink()) {
        rmdirSync(source)
        undo.push(() => mkdirSync(source, { mode: prior.mode & 0o777 }))
      }
      const staged = join(journal, 'new-' + index)
      const stagedStat = stagedStats.get(index)!
      if (!sameStat(stagedStat, lstatSync(staged))) throw new Error('The project file copy changed: ' + path)
      linkSync(staged, source)
      let published: Stats | undefined
      undo.push(() => {
        const target = filePath(baseline.sourceRoot, path)
        const actual = optionalStat(target)
        if (!actual) return
        if (!(published ? sameStat(published, actual) : sameStat(stagedStat, actual, true, 1))) {
          throw new Error('The published file changed: ' + path)
        }
        unlinkSync(target)
      })
      const actual = lstatSync(source)
      if (!sameStat(stagedStat, actual, true, 1)) throw new Error('The published file changed: ' + path)
      published = actual
    }
  } catch (error) {
    const failures: unknown[] = []
    for (const rollback of undo.reverse()) {
      try {
        rollback()
      } catch (failure) {
        failures.push(failure)
      }
    }
    if (failures.length) {
      preserve = true
      throw new AggregateError([error, ...failures], 'Source apply could not finish rolling back. Recovery files are at ' + journal)
    }
    throw error
  } finally {
    if (!preserve) await rm(journal, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}
