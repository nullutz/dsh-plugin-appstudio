import type { Context } from '@deepseek-ai/cordis'
import type { FrameworkId } from '../shared/protocol.ts'
import { buildAndroidProject, type AndroidArtifact, type AndroidBuildRequest, type AndroidBuildRun } from './build.ts'

export interface FrameworkCapability {
  signal: AbortSignal
  build(run: AndroidBuildRun, request: Omit<AndroidBuildRequest, 'framework'>): Promise<AndroidArtifact>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    appStudioFlutter: FrameworkCapability
    appStudioReactNative: FrameworkCapability
    appStudioNativeAndroid: FrameworkCapability
  }
}

export const frameworkService = {
  flutter: 'appStudioFlutter',
  'react-native': 'appStudioReactNative',
  android: 'appStudioNativeAndroid',
} as const

export const frameworks: readonly FrameworkId[] = ['flutter', 'react-native', 'android']

export function registerFramework(ctx: Context, framework: FrameworkId): void {
  const lifetime = new AbortController()
  ctx.provide(frameworkService[framework], {
    signal: lifetime.signal,
    build: (run, request) => buildAndroidProject(run, { ...request, framework }),
  })
  ctx.effect(() => () => lifetime.abort())
}
