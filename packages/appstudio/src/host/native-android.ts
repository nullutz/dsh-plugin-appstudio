import type { Context } from '@deepseek-ai/cordis'
import { registerFramework } from '../project/frameworks.ts'

export function apply(ctx: Context): void {
  registerFramework(ctx, 'android')
}
