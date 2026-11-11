import type { IterationComment, IterationRequest } from '../shared/protocol.ts'

const storeName = 'comments'
const lastProjectKey = 'dsh-appstudio.last-project'

export interface PendingBatch {
  batchId: string
  sessionId: string
  commentIds: string[]
  retryOf: string | null
  repairNote: string
}

export function lastIterationProject(projectRoot?: string): string {
  try {
    if (projectRoot) localStorage.setItem(lastProjectKey, projectRoot)
    return projectRoot ?? localStorage.getItem(lastProjectKey) ?? ''
  } catch {
    return projectRoot ?? ''
  }
}

export function readPendingBatch(projectRoot: string): PendingBatch | undefined {
  try {
    const batch = JSON.parse(sessionStorage.getItem('dsh-appstudio.pending:' + projectRoot) ?? 'null') as PendingBatch | null
    if (batch && typeof batch.batchId === 'string' && typeof batch.sessionId === 'string' &&
        (batch.retryOf === null || typeof batch.retryOf === 'string') && typeof batch.repairNote === 'string' &&
        Array.isArray(batch.commentIds) && batch.commentIds.every(id => typeof id === 'string')) return batch
  } catch {
    // Draft storage can be unavailable when opening the Workbench.
  }
  return undefined
}

export function writePendingBatch(projectRoot: string, batch: PendingBatch | undefined): void {
  try {
    const key = 'dsh-appstudio.pending:' + projectRoot
    if (batch) sessionStorage.setItem(key, JSON.stringify(batch))
    else sessionStorage.removeItem(key)
  } catch {
    // The Host can still accept the batch if browser session storage is unavailable.
  }
}

export function nextDrafts(comments: IterationComment[], batch: PendingBatch | undefined): IterationComment[] {
  if (!batch?.commentIds.length) return comments
  const submitted = new Set(batch.commentIds)
  return comments.filter(comment => !submitted.has(comment.id))
}

export function pendingRequest(projectRoot: string, batch: PendingBatch, drafts: IterationComment[]): IterationRequest | undefined {
  const comments: IterationComment[] = []
  for (const id of batch.commentIds) {
    const comment = drafts.find(draft => draft.id === id)
    if (!comment) return undefined
    comments.push(comment)
  }
  return { projectRoot, sessionId: batch.sessionId, batchId: batch.batchId, comments, retryOf: batch.retryOf, repairNote: batch.repairNote }
}

async function openDrafts(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dsh-appstudio-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function projectDrafts(
  projectRoot: string,
  update?: (current: IterationComment[]) => IterationComment[],
): Promise<IterationComment[]> {
  const database = await openDrafts()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, update ? 'readwrite' : 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.get(projectRoot)
      let comments: IterationComment[] = []
      let failure: unknown
      transaction.oncomplete = () => resolve(comments)
      transaction.onabort = () => reject(failure ?? transaction.error)
      request.onsuccess = () => {
        comments = (request.result as IterationComment[] | undefined) ?? []
        if (!update) return
        try {
          comments = update(comments)
          store.put(comments, projectRoot)
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
    })
  } finally {
    database.close()
  }
}
