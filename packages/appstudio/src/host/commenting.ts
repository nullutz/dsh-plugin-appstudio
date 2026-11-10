import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    appStudioCommenting: boolean
  }
}

export function apply(ctx: Context): void {
  ctx.provide('appStudioCommenting', true)
}
