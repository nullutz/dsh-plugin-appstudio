import { posix } from 'node:path'
import type { RuntimeProcessOptions } from '../runtime/manager.ts'

export type AndroidFramework = 'flutter' | 'react-native' | 'android'

export interface AndroidBuildRequest {
  framework: AndroidFramework
  /** Linux path to the staged project root. */
  projectDir: string
  signal?: AbortSignal
  onLog?: (text: string) => void
}

export interface AndroidArtifact {
  apkPath: string
  applicationId: string
  launchActivity: string
  versionCode: number
}

export type AndroidBuildRun = (argv: readonly string[], options?: RuntimeProcessOptions) => Promise<{
  code: number | null
  stdout: string
  stderr: string
}>

const root = '/opt/appstudio'
const sdk = `${root}/android-sdk`
const tools = `${root}/build-tools`
const java = '/usr/lib/jvm/java-21-openjdk-amd64'
const buildTimeout = 30 * 60_000
const inspectTimeout = 30_000
const environment = [
  `PATH=${tools}/node/bin:${java}/bin:/usr/local/bin:/usr/bin:/bin`,
  `JAVA_HOME=${java}`,
  `ANDROID_HOME=${sdk}`,
  `ANDROID_SDK_ROOT=${sdk}`,
  `GRADLE_USER_HOME=${tools}/cache/gradle`,
  `PUB_CACHE=${tools}/cache/pub`,
  `npm_config_cache=${tools}/cache/npm`,
  'GIT_CONFIG_COUNT=1',
  'GIT_CONFIG_KEY_0=safe.directory',
  `GIT_CONFIG_VALUE_0=${tools}/flutter`,
  'CI=true',
  'FLUTTER_SUPPRESS_ANALYTICS=true',
]

const gradleDebug = [':app:assembleDebug', '--console=plain', '--no-daemon', '--max-workers=3']
const gradleApk = 'app/build/outputs/apk/debug/app-debug.apk'

function parseBadging(badging: string): Omit<AndroidArtifact, 'apkPath'> {
  const pkg = /^package:\s+name='([\w.]+)'\s+versionCode='([0-9]+)'/m.exec(badging)
  const activity = /^launchable-activity:\s+name='([\w.$]+)'/m.exec(badging)
  const versionCode = Number(pkg?.[2])
  if (!pkg || !activity || !Number.isSafeInteger(versionCode)) {
    throw new Error('The Android APK must declare an application ID, version code, and launchable activity.')
  }
  if (!/^application-debuggable\s*$/m.test(badging)) {
    throw new Error('The Android APK must be debuggable to exchange test scenes.')
  }
  const nativeCode = /^native-code:(.*)$/m.exec(badging)
  if (nativeCode && !nativeCode[1].includes("'x86_64'")) {
    throw new Error('The Android APK has native libraries but does not support the x86_64 emulator.')
  }
  const applicationId = pkg[1]
  const launchActivity = activity[1].startsWith('.') ? applicationId + activity[1] : activity[1]
  return { applicationId, launchActivity, versionCode }
}

/** Build a standalone debug APK inside the owned Android WSL environment. */
export async function buildAndroidProject(run: AndroidBuildRun, request: AndroidBuildRequest): Promise<AndroidArtifact> {
  const { framework, projectDir, signal, onLog } = request
  if (!posix.isAbsolute(projectDir) || projectDir === '/' || posix.resolve(projectDir) !== projectDir ||
      /[\0\r\n]/.test(projectDir)) {
    throw new Error('A normalized Linux project directory is required.')
  }

  async function execute(
    cwd: string,
    argv: readonly string[],
    label: string,
    timeoutMs: number,
    logOutput = false,
  ): Promise<string> {
    signal?.throwIfAborted()
    if (logOutput) onLog?.(label + '\n')
    const result = await run(['/usr/bin/env', '--chdir', cwd, ...environment, ...argv], { timeoutMs, signal })
    signal?.throwIfAborted()
    if (logOutput) {
      if (result.stdout) onLog?.(result.stdout)
      if (result.stderr) onLog?.(result.stderr)
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-1000)
      throw new Error(`${label} failed (${result.code ?? 'terminated'}).${detail ? ' ' + detail : ''}`)
    }
    return result.stdout
  }

  async function normalizeGradleWrapper(cwd: string, wrapper: string, optional = false): Promise<void> {
    if (optional) {
      const result = await run(['/usr/bin/env', '--chdir', cwd, '/usr/bin/test', '-f', wrapper], {
        timeoutMs: inspectTimeout, signal,
      })
      signal?.throwIfAborted()
      if (result.code === 1) return
      if (result.code !== 0) throw new Error('Flutter Gradle wrapper check failed.')
    }
    // The build runs against a private snapshot. Windows checkouts can supply CRLF wrappers.
    await execute(cwd, ['/usr/bin/sed', '-i', 's/\\r$//', '--', wrapper], 'Gradle wrapper preparation', inspectTimeout)
  }

  let output: string
  switch (framework) {
    case 'flutter':
      await normalizeGradleWrapper(projectDir, './android/gradlew', true)
      await execute(projectDir, [`${tools}/flutter/bin/flutter`, 'build', 'apk', '--debug',
        '--target-platform', 'android-x64'], 'Flutter Android build', buildTimeout, true)
      output = 'build/app/outputs/flutter-apk/app-debug.apk'
      break
    case 'react-native': {
      await execute(projectDir, ['/usr/bin/test', '-f', 'package-lock.json'], 'React Native npm lockfile check', inspectTimeout)
      await execute(projectDir, [`${tools}/node/bin/npm`, 'ci', '--no-audit', '--no-fund', '--prefer-offline'],
        'React Native dependency install', buildTimeout, true)
      const androidDir = posix.join(projectDir, 'android')
      await normalizeGradleWrapper(androidDir, './gradlew')
      await execute(androidDir, ['/bin/bash', './gradlew', ...gradleDebug, '-PreactNativeArchitectures=x86_64',
        '--init-script', `${root}/runtime/react-native.init.gradle`], 'React Native Android build', buildTimeout, true)
      output = 'android/' + gradleApk
      break
    }
    case 'android':
      await normalizeGradleWrapper(projectDir, './gradlew')
      await execute(projectDir, ['/bin/bash', './gradlew', ...gradleDebug], 'Native Android build', buildTimeout, true)
      output = gradleApk
      break
    default:
      throw new Error('Unknown Android framework.')
  }

  const path = posix.join(projectDir, output)
  await execute(projectDir, ['/usr/bin/test', '-f', path], 'Android APK output check', inspectTimeout)
  const apkPath = (await execute(projectDir, ['/usr/bin/realpath', '--', path], 'Android APK path check', inspectTimeout)).trim()
  if (!apkPath.startsWith(projectDir + '/') || posix.normalize(apkPath) !== apkPath || /[\0\r\n]/.test(apkPath)) {
    throw new Error('The Android APK output must remain inside the staged project.')
  }
  if (framework === 'react-native') {
    await execute(projectDir, ['/usr/bin/unzip', '-Z', '-1', apkPath, 'assets/index.android.bundle'],
      'React Native embedded bundle check', inspectTimeout)
  }
  const badging = await execute(projectDir, [`${sdk}/build-tools/36.0.0/aapt`, 'dump', 'badging', apkPath],
    'Android APK manifest inspection', inspectTimeout)
  return { apkPath, ...parseBadging(badging) }
}
