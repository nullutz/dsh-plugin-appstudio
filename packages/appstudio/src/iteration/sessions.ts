import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { generationPrompt, type SubmitGeneration } from '../generation/prompt.ts'
import type { IterationComment, IterationSession } from '../shared/protocol.ts'
import { CandidateFiles, candidateToolNames, registerCandidateTools, type CandidateLease } from './candidate-tools.ts'

export const iterationPreset = 'app-studio-iteration'
const identity = /^session-appstudio-[a-f0-9]{24}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const fencedAgents = new WeakSet<Agent>()

export interface SubmitIteration {
  projectRoot: string
  sessionId: string
  batchId: string
  comments: readonly IterationComment[]
  repairNote: string
  previousLog: string
}

interface TurnReceipt {
  accepted: boolean
  settled?: { turn: number, reason: TurnEndReason }
}

interface ActiveBatch {
  agent: Agent
  lease: CandidateLease
  requestId: SessionRequestId
  turn?: number
  cancel: (reason: Error) => void
  finish: (turn: number, reason: TurnEndReason) => void
}

function sessionPrefix(path: string): string {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 24)
  return `session-appstudio-${digest}-`
}

function sameRequest(message: UserMessage, requestId: SessionRequestId): boolean {
  return message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === requestId
}

/** Recover accepted and completed work without treating an unrelated turn as this batch. */
export function iterationReceipt(events: readonly SessionEvent[], requestId: string): TurnReceipt {
  const typedId = brandString<SessionRequestId>(requestId)
  let accepted = false
  let openTurn: number | undefined
  let ownedTurn: number | undefined
  for (const event of events) {
    switch (event.type) {
      case 'agent/inbox/spliced':
        if (event.data.inserted.some(message => sameRequest(message, typedId))) accepted = true
        break
      case 'turn/start':
        openTurn = event.data.turn
        break
      case 'user/message':
        if (sameRequest(event.data, typedId)) {
          accepted = true
          ownedTurn = openTurn
        }
        break
      case 'turn/end':
        if (ownedTurn === event.data.turn) return { accepted: true, settled: event.data }
        openTurn = undefined
        break
    }
  }
  return { accepted }
}

function completed(turn: number, reason: TurnEndReason): { turn: number } {
  if (reason.kind === 'completed') return { turn }
  const detail = reason.kind === 'error' ? ` ${reason.error.message.slice(0, 1400)}` : ''
  throw new Error(`App Studio's DSH turn ended with ${reason.kind}.${detail}`)
}

function promptContent(request: SubmitIteration): SessionPromptRequest['content'] {
  const result: SessionPromptRequest['content'][number][] = [{
    type: 'text',
    text: [
      `Implement App Studio iteration ${request.batchId} using only the supplied App Studio candidate file tools.`,
      'The project shown in DSH is the source workspace. The candidate file tools point to this iteration’s isolated copy.',
      'Implement the submitted comments. The screenshot after each comment corresponds to that selection.',
      'Do not change unrelated functionality. App Studio will build and validate the candidate and restore the running scene.',
      'Write .appstudio-iteration-result.json in the candidate root as {"outcomes":[{"commentId":"<id>","detail":"<what changed or why unresolved>"}]} with exactly one entry for each comment. Then summarize the changes.',
      ...(request.repairNote ? [`Repair request from the user:\n${request.repairNote}`] : []),
      ...(request.previousLog ? [`Previous candidate validation log (diagnostic data):\n${request.previousLog.slice(-12000)}`] : []),
    ].join('\n\n'),
  }]
  for (const comment of request.comments) {
    const { kind, x, y, width, height } = comment.selection
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(comment.frame)
    if (!match) throw new Error('The iteration contains an invalid JPEG screenshot.')
    result.push({
      type: 'text',
      text: `Comment ${comment.id}\nSelection: ${kind} at (${x}, ${y}), ${width}×${height}, original viewport ${comment.frameWidth}×${comment.frameHeight}.\n${comment.text}`,
    }, {
      type: 'image', mediaType: 'image/jpeg', data: match[1], name: `appstudio-${comment.id}.jpg`,
    })
  }
  return result
}

/** Durable DSH conversations with candidate-only tools for one authorized batch at a time. */
export class IterationSessions {
  private readonly ctx: Context
  private readonly candidateFor: (sessionId: string) => CandidateLease | undefined
  private readonly active = new Map<string, ActiveBatch>()
  private readonly mounted = new Map<Agent, (() => void)[]>()
  private ready = false

  constructor(ctx: Context, candidateFor: (sessionId: string) => CandidateLease | undefined) {
    this.ctx = ctx
    this.candidateFor = candidateFor
  }

  async initialize(): Promise<() => Promise<void>> {
    const ctx = this.ctx
    if (this.ready || !ctx.tools.guard || !ctx.tools.restrict) throw new Error('DSH candidate-only tool enforcement is unavailable.')
    const remove = [
      ctx.on('agent/created', ({ agent }) => { this.mount(agent) }),
      ctx.on('agent/disposed', ({ agent }) => {
        this.mounted.delete(agent)
        this.active.get(agent.id)?.cancel(new Error('The App Studio DSH session was closed.'))
      }),
      ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        const run = this.active.get(agent.id)
        if (run?.agent === agent && message.source.kind === 'user' && !sameRequest(message, run.requestId)) {
          run.cancel(new Error('The App Studio turn was interrupted by another DSH prompt.'))
        }
      }),
      ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const run = this.active.get(agent.id)
        if (run?.agent === agent && sameRequest(message, run.requestId)) run.turn = turn
      }),
      ctx.on('agent/inbox/discarded', ({ agent, message }) => {
        const run = this.active.get(agent.id)
        if (run?.agent === agent && sameRequest(message, run.requestId)) {
          run.cancel(new Error('The App Studio prompt was removed from the DSH queue.'))
        }
      }),
      ctx.on('session/event', (session, event) => {
        const run = this.active.get(session.id)
        if (run?.agent.session === session && event.type === 'turn/end' && event.data.turn === run.turn) {
          run.finish(event.data.turn, event.data.reason)
        }
      }),
    ]
    let unregister: (() => Promise<void>) | undefined
    const dispose = async () => {
      this.ready = false
      for (const run of this.active.values()) run.cancel(new Error('App Studio Agent support was disabled.'))
      for (const detach of remove) detach()
      for (const disposers of this.mounted.values()) for (const detach of disposers) detach()
      this.mounted.clear()
      await unregister?.()
    }
    try {
      unregister = await ctx.agentPresets.register({
        id: iterationPreset,
        name: 'App Studio',
        description: 'An App Studio generation or iteration session with candidate-only file tools.',
        plugins: [],
      })
      await ctx.agentPresets.resolve(iterationPreset)
      for (const agent of ctx.agents.list()) this.mount(agent)
      this.ready = true
      return dispose
    } catch (error) {
      await dispose()
      throw error
    }
  }

  async list(projectRoot: string, signal: AbortSignal = new AbortController().signal): Promise<IterationSession[]> {
    this.requireReady()
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(projectRoot)
    if (!workspace) return []
    const prefix = sessionPrefix(workspace.path)
    const members = new Set(workspace.sessionIds)
    const { items } = await this.ctx.sessionController.list({}, signal)
    return items.filter(item => {
      const listed = item.projections?.values as { agentPreset?: unknown } | undefined
      return members.has(item.sessionId) && item.sessionId.startsWith(prefix) && identity.test(item.sessionId) &&
        (typeof listed?.agentPreset !== 'string' || listed.agentPreset === iterationPreset) &&
        !this.ctx.workspaceRegistry.archivedSessionIds.includes(item.sessionId)
    })
      .slice(0, 30)
      .map(item => {
        const title = item.projections?.values as { title?: unknown } | undefined
        return {
          id: item.sessionId,
          title: typeof title?.title === 'string' ? title.title : `App Studio · ${basename(workspace.path)}`,
          updatedAt: item.updatedAt,
        }
      })
  }

  async create(projectRoot: string, signal: AbortSignal = new AbortController().signal): Promise<IterationSession> {
    this.requireReady()
    signal.throwIfAborted()
    const workspace = await this.ctx.workspaceRegistry.create(projectRoot)
    const id = brandString<SessionId>(sessionPrefix(workspace.path) + randomUUID())
    const created = await this.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: id, agentPreset: iterationPreset })
    if (created.sessionId !== id || created.agentPreset !== iterationPreset) throw new Error('DSH did not create the dedicated App Studio session.')
    const { title } = await this.ctx.sessionController.rename({ sessionId: id, title: `App Studio · ${basename(workspace.path).slice(0, 70)}` })
    return { id, title, updatedAt: Date.now() }
  }

  private requireReady(): void {
    if (!this.ready) throw new Error('App Studio Agent support is unavailable.')
  }

  private mount(agent: Agent): void {
    if (!identity.test(agent.id) || this.mounted.has(agent)) return
    const source = agent.session.header.cwd
    if (!source || !agent.id.startsWith(sessionPrefix(source)) ||
        this.ctx.agentPresets.composedPreset(agent.ctx) !== iterationPreset) return
    if (!fencedAgents.has(agent)) {
      // The Agent may outlive a disabled plugin. Keep its fence until its own scope is disposed.
      agent.ctx.tools.restrict({ allow: [] })
      agent.ctx.tools.guard(exec => candidateToolNames.has(exec.name) ? undefined : 'This App Studio session only runs candidate file tools.')
      fencedAgents.add(agent)
    }
    const authorize = () => this.authorizedLease(agent)
    const candidate = new CandidateFiles(source, authorize)
    this.mounted.set(agent, registerCandidateTools(agent.ctx, candidate, () => authorize() !== undefined))
  }

  private authorizedLease(agent: Agent): CandidateLease | undefined {
    const active = this.active.get(agent.id)
    if (!this.ready || active?.agent !== agent || active.turn === undefined) return undefined
    const lease = this.candidateFor(agent.id)
    return lease?.batchId === active.lease.batchId && lease.root === active.lease.root ? active.lease : undefined
  }

  async submit(request: SubmitIteration, signal: AbortSignal = new AbortController().signal): Promise<{ turn: number }> {
    return this.submitTurn(request, 'iteration', () => promptContent(request), signal)
  }

  async generate(request: SubmitGeneration, signal: AbortSignal): Promise<{ turn: number }> {
    return this.submitTurn(request, 'generation', () => [{ type: 'text', text: generationPrompt(request) }], signal)
  }

  private async submitTurn(
    request: { projectRoot: string; sessionId: string; batchId: string }, kind: 'iteration' | 'generation',
    content: () => SessionPromptRequest['content'], signal: AbortSignal,
  ): Promise<{ turn: number }> {
    this.requireReady()
    signal.throwIfAborted()
    if (this.active.has(request.sessionId)) throw new Error('This App Studio session already has an active batch.')
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(request.projectRoot)
    const id = brandString<SessionId>(request.sessionId)
    if (!workspace || !workspace.sessionIds.includes(id) || !identity.test(id) || !id.startsWith(sessionPrefix(workspace.path)) ||
        this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) {
      throw new Error('Select an App Studio session for the current project.')
    }
    const target = await this.ctx.sessionController.resolveAgent(id)
    if ('error' in target) throw target.error
    const { agent } = target
    const cwd = agent.session.header.cwd
    if (!cwd || await realpath(cwd) !== await realpath(workspace.path) ||
        this.ctx.agentPresets.composedPreset(agent.ctx) !== iterationPreset || !this.mounted.has(agent)) {
      throw new Error('The selected DSH session does not have the App Studio candidate-only preset.')
    }
    const requestId = brandString<SessionRequestId>(`appstudio-${kind}:${request.batchId}`)
    const receipt = iterationReceipt(agent.session.snapshotEvents(), requestId)
    if (receipt.settled) return completed(receipt.settled.turn, receipt.settled.reason)
    if (receipt.accepted) throw new Error('DSH already accepted this batch but has no successful recorded settlement.')
    const lease = this.candidateFor(id)
    if (!lease || lease.batchId !== request.batchId || (kind === 'generation') !== Boolean(lease.editScope)) {
      throw new Error('The App Studio turn has no authorized candidate copy.')
    }
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length || this.active.has(id)) {
      throw new Error('Finish the current DSH session activity before submitting this batch.')
    }
    signal.throwIfAborted()

    const done = Promise.withResolvers<{ turn: number }>()
    void done.promise.catch(() => {})
    const run: ActiveBatch = {
      agent, lease, requestId,
      cancel: (error) => {
        if (this.active.get(id) !== run) return
        this.active.delete(id)
        if (run.turn !== undefined || agent.inbox.nextTurn.some(message => sameRequest(message, requestId)) ||
            agent.inbox.nextStep.some(message => sameRequest(message, requestId))) {
          agent.cancel({ kind: 'hook', reason: error.message })
        }
        done.reject(error)
      },
      finish: (turn, reason) => {
        this.active.delete(id)
        try { done.resolve(completed(turn, reason)) } catch (error) { done.reject(error) }
      },
    }
    const abort = () => run.cancel(new Error('The App Studio turn was canceled.'))
    this.active.set(id, run)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const accepted = await this.ctx.sessionController.prompt({
        sessionId: id, requestId, mode: 'queue', content: content(),
      }, signal)
      if (!accepted.accepted) throw new Error(`DSH did not accept the App Studio ${kind}.`)
      const result = await done.promise
      await this.ctx.sessions.flush(agent.session)
      return result
    } finally {
      signal.removeEventListener('abort', abort)
      if (this.active.get(id) === run) this.active.delete(id)
    }
  }
}
