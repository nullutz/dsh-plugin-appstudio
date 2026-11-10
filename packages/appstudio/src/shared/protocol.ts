export type DeviceRole = 'live' | 'candidate'

export interface AndroidDevice {
  id: DeviceRole
  width: number
  height: number
}

export type RuntimePhase = 'unsupported' | 'unconfigured' | 'preparing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface RuntimeView {
  phase: RuntimePhase
  detail: string
  androidEnabled: boolean
  devices: AndroidDevice[]
  frameworks: FrameworkId[]
  commentingEnabled: boolean
  iterationEnabled: boolean
  layoutEnabled: boolean
  promptEnabled: boolean
}

export type FrameworkId = 'flutter' | 'react-native' | 'android'

export interface ProjectRunConfig {
  projectRoot: string
  framework: FrameworkId
}

export interface ProjectView {
  activeRole: DeviceRole
  deploymentId?: string
  projectRoot: string
  framework: FrameworkId | null
  applicationId: string
  versionCode: string
  restored: boolean
}

export type ProjectRunEvent =
  | { kind: 'progress'; text: string }
  | { kind: 'log'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'ready'; project: ProjectView }

export type GenerationMode = 'layout' | 'prompt'
export type StarterBlockKind = 'heading' | 'text' | 'image' | 'input' | 'button' | 'list' | 'divider'

export interface StarterBlock {
  id: string
  kind: StarterBlockKind
  text: string
}

export interface StarterScreen {
  id: string
  title: string
  blocks: StarterBlock[]
}

export interface StarterLayout {
  screens: StarterScreen[]
}

export interface GenerationRequest extends ProjectRunConfig {
  batchId: string
  mode: GenerationMode
  name: string
  brief: string
  layout: StarterLayout | null
  retryOf: string | null
  repairNote: string
}

export interface GenerationView extends ProjectRunConfig {
  batchId: string
  mode: GenerationMode
  sessionId: string | null
  phase: 'queued' | 'scaffolding' | 'editing' | 'building' | 'validating' | 'applied' | 'failed'
  detail: string
  log: string
  project: ProjectView | null
}

export interface IterationSelection {
  kind: 'point' | 'area'
  x: number
  y: number
  width: number
  height: number
}

export interface IterationComment {
  id: string
  text: string
  selection: IterationSelection
  frame: string
  frameWidth: number
  frameHeight: number
}

export interface IterationSession {
  id: string
  title: string
  updatedAt: number
}

export interface IterationRequest {
  projectRoot: string
  sessionId: string
  batchId: string
  comments: IterationComment[]
  retryOf: string | null
  repairNote: string
}

export interface IterationOutcome {
  commentId: string
  commentText: string
  status: 'reported' | 'unverified'
  detail: string
}

export interface IterationView {
  batchId: string
  sessionId: string
  projectRoot: string
  phase: 'queued' | 'editing' | 'building' | 'validating' | 'applied' | 'failed'
  detail: string
  log: string
  diff: string
  project: ProjectView | null
  outcomes: IterationOutcome[]
}
