import type { Context } from '@deepseek-ai/cordis'
import type { GenerationCoordinator } from '../generation/contract.ts'
import type { SubmitGeneration } from '../generation/prompt.ts'
import type { IterationJobs } from '../iteration/jobs.ts'
import type { IterationComment, IterationSession } from '../shared/protocol.ts'

export interface IterationFeature {
  jobs: IterationJobs
  generation: GenerationCoordinator
  sessions: {
    list(projectRoot: string, signal: AbortSignal): Promise<IterationSession[]>
    create(projectRoot: string, signal: AbortSignal): Promise<IterationSession>
    submit(input: {
      projectRoot: string; sessionId: string; batchId: string; comments: readonly IterationComment[]
      repairNote: string; previousLog: string
    }, signal: AbortSignal): Promise<{ turn: number }>
    generate(input: SubmitGeneration, signal: AbortSignal): Promise<{ turn: number }>
  }
  signal: AbortSignal
}

export const inject = ['agents', 'tools', 'agentPresets', 'workspaceRegistry', 'sessionController', 'sessions']

export async function apply(ctx: Context): Promise<void> {
  // The Agent implementation loads DSH Session's ambient Typert maps. Keep
  // those out of the independent public wire analysis and load it on enable.
  const implementation = new URL('./iteration-host.js', import.meta.url).href
  const { startIterations }: { startIterations(ctx: Context): Promise<void> } = await import(implementation)
  await startIterations(ctx)
}
