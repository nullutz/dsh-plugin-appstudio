import { realpath, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { create } from 'tar'

const ignored = new Set(['.git', '.gradle', '.dart_tool', '.cxx', 'node_modules', 'local.properties'])
const generated = /^(?:build|android\/build|android\/app\/build|app\/build|\.idea)(?:\/|$)/
const sourceLimit = 1024 * 1024 * 1024

export function projectSourceIncluded(relative: string): boolean {
  const key = relative.toLowerCase()
  const top = key.split('/')[0]
  return top !== '.appstudio-iteration-result.json' && top !== '.appstudio-apply-lock' &&
    !key.split('/').some(segment => ignored.has(segment)) && !generated.test(key)
}

export async function projectDirectory(path: string): Promise<string> {
  if (path.length > 4096 || !/^[a-z]:[\\/]/i.test(path) || /[\u0000-\u001f]/.test(path)) {
    throw new Error('Select an absolute Windows project directory on a local drive.')
  }
  const resolved = await realpath(path)
  if (!/^[a-z]:[\\/]/i.test(resolved) || resolved === win32.parse(resolved).root || !(await stat(resolved)).isDirectory()) {
    throw new Error('Select a project folder on a local Windows drive.')
  }
  return resolved
}

/** Send a source snapshot without mounting the Windows filesystem inside WSL. */
export async function* projectArchive(cwd: string): AsyncIterable<Uint8Array> {
  let blockedLink: string | undefined
  const archive = create({
    cwd, portable: true, strict: true,
    filter(path, info) {
      const relative = path.replaceAll('\\', '/').replace(/^\.\//, '')
      if (!projectSourceIncluded(relative)) return false
      if (!('isSymbolicLink' in info)) return false
      if (info.isSymbolicLink()) {
        blockedLink ??= relative
        return false
      }
      return info.isDirectory() || info.isFile()
    },
  }, ['.'])
  let bytes = 0
  try {
    for await (const chunk of archive) {
      bytes += chunk.byteLength
      if (bytes > sourceLimit) throw new Error('The project source snapshot exceeds 1 GiB.')
      yield chunk
    }
    if (blockedLink) throw new Error('The project contains a symbolic link: ' + blockedLink)
  } finally {
    archive.destroy()
  }
}
