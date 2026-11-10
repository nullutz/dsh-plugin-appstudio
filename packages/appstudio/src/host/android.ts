import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-subprocess'
import { AndroidRuntimeManager } from '../runtime/manager.ts'
import { runtimeProcesses } from './process.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    appStudioAndroid: AppStudioAndroid
  }
}

export default class AppStudioAndroid extends Service {
  static inject = ['subprocess'] as const
  readonly manager: AndroidRuntimeManager
  readonly lifetime: AbortController = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'appStudioAndroid')
    const dshHome = resolveDshHome()
    this.manager = new AndroidRuntimeManager({
      dataDir: join(dshHome, 'appstudio', 'android'),
      assetDir: fileURLToPath(new URL('./runtime/', import.meta.url)),
      runner: runtimeProcesses(ctx.subprocess, dshHome),
    })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.manager.dispose()
    })
  }
}
