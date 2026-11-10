import type { Context } from '@deepseek-ai/cordis'
import { registerStarter } from './starter.ts'

export function apply(ctx: Context): void {
  registerStarter(ctx, 'appStudioPrompt')
}
