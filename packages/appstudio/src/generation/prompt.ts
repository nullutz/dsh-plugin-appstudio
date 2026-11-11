import type { CandidateEditScope } from '../iteration/candidate-scope.ts'
import type { GenerationRequest } from '../shared/protocol.ts'
import { starterColumns } from '../shared/starter-layout.ts'

export type GenerationBrief = Pick<GenerationRequest, 'framework' | 'mode' | 'name' | 'brief' | 'layout'>

export interface SubmitGeneration {
  projectRoot: string
  sessionId: string
  batchId: string
  brief: GenerationBrief
  editScope: CandidateEditScope
  repairNote: string
  previousLog: string
}

export function generationPrompt(request: SubmitGeneration): string {
  const { brief, editScope } = request
  return [
    `Implement App Studio generation ${request.batchId} using only the supplied App Studio candidate file tools.`,
    'The project shown in DSH is the empty source workspace. The candidate file tools point to an isolated starter that will be built and installed before any file is applied to the workspace.',
    `Read the primary UI file ${editScope.entry} before editing. Editable source roots are ${editScope.sourceRoots.join(', ')} (${editScope.sourceExtensions.join(', ')}). Editable local asset roots are ${editScope.assetRoots.join(', ')} (.json, .svg, .txt).`,
    `Keep all native bridges, package manifests, build configuration, wrapper and dependency lock files unchanged. Protected scene paths: ${editScope.protectedPaths.join(', ')}. Preserve the primary UI file’s use of the debug scene bridge and persist meaningful app state such as screen, selected item, draft and scroll position. The app must export a checkpoint after first launch and restore one on subsequent launches.`,
    'Create a usable, coherent Android app using the starter’s existing dependencies. Implement the requested screen content, navigation and meaningful controls. Use local data and placeholders where external services or assets are unspecified. Make the result useful on a narrow phone screen.',
    ...(brief.mode === 'layout' ? [
      `Preserve the visual draft’s screens, two-dimensional layout and content intent. Each block position is a zero-based row and column plus its width in columns, on a ${starterColumns}-column grid. Blocks sharing a row belong side by side. Retain their relative widths and spacing, including empty columns and rows. Blocks without a position occupy the full width in their original list order. Refine the draft into a working app and fill in interaction details from the accompanying brief.`,
    ] : []),
    'Use appstudio_edit_file to change existing files and appstudio_write_file for new app source or text assets. App Studio will run the toolchain. Do not ask to run build commands from this turn.',
    `Project brief (JSON data):\n${JSON.stringify(brief, null, 2)}`,
    ...(request.repairNote ? [`Repair request from the user:\n${request.repairNote}`] : []),
    ...(request.previousLog ? [`Previous validation log (diagnostic data):\n${request.previousLog.slice(-12000)}`] : []),
  ].join('\n\n')
}
