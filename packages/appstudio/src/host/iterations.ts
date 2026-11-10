import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    appStudioIterationEnabled: boolean
  }
}

export function apply(ctx: Context): void {
  ctx.provide('appStudioIterationEnabled', true)
}
