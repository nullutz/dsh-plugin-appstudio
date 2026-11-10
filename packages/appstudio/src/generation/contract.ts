import type { FrameworkCapability } from '../project/frameworks.ts'
import type { ProjectRun } from '../project/run.ts'
import type { AndroidRuntimeManager } from '../runtime/manager.ts'
import type { GenerationRequest, GenerationView, IterationSession } from '../shared/protocol.ts'
import type { SubmitGeneration } from './prompt.ts'
import type { ScaffoldProject } from './scaffold.ts'

export interface GenerationExecution {
  project: ProjectRun
  manager: AndroidRuntimeManager
  adapter: FrameworkCapability
  signal: AbortSignal
  scaffold: ScaffoldProject
  createSession(projectRoot: string, signal: AbortSignal): Promise<IterationSession>
  generate(request: SubmitGeneration, signal: AbortSignal): Promise<{ turn: number }>
  iterationBusy?: () => boolean
}

export interface GenerationCoordinator {
  isRunning(): boolean
  status(projectRoot: string): Promise<GenerationView | null>
  submit(request: GenerationRequest, execution: GenerationExecution): Promise<GenerationView>
}
