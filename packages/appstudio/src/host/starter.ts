import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    appStudioLayout: AbortSignal
    appStudioPrompt: AbortSignal
  }
}

export function registerStarter(ctx: Context, service: 'appStudioLayout' | 'appStudioPrompt'): void {
  const lifetime = new AbortController()
  ctx.provide(service, lifetime.signal)
  ctx.effect(() => () => lifetime.abort())
}
