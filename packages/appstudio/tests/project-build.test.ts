import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAndroidProject, type AndroidBuildRun, type AndroidFramework } from '../src/project/build.ts'

const projectDir = '/opt/appstudio/projects/scene test'
const validBadging = [
  "package: name='dev.appstudio.scene' versionCode='5' versionName='1.0'",
  "launchable-activity: name='dev.appstudio.scene.MainActivity' label='Scene'",
  'application-debuggable',
  "native-code: 'x86_64'",
].join('\n')

function fakeRun(overrides: {
  badging?: string
  apkPath?: string
  bundleMissing?: boolean
  commandFailure?: string
} = {}) {
  const commands: Array<{ cwd: string, argv: readonly string[] }> = []
  const run: AndroidBuildRun = async (args) => {
    assert.deepEqual(args.slice(0, 2), ['/usr/bin/env', '--chdir'])
    const commandIndex = args.findIndex((arg, index) => index > 2 && arg.startsWith('/'))
    const argv = args.slice(commandIndex)
    const command = argv[0]
    commands.push({ cwd: args[2], argv })
    if (command === overrides.commandFailure || (command.endsWith('/unzip') && overrides.bundleMissing)) {
      return { code: 1, stdout: '', stderr: 'test command failure' }
    }
    const stdout = command.endsWith('/aapt')
      ? overrides.badging ?? validBadging
      : command.endsWith('/realpath') ? overrides.apkPath ?? argv[2] : ''
    return { code: 0, stdout, stderr: '' }
  }
  return { run, commands }
}

test('builds Flutter for the Android x86_64 emulator and inspects the debug APK', async () => {
  const { run, commands } = fakeRun()
  const artifact = await buildAndroidProject(run, { framework: 'flutter', projectDir })
  assert.deepEqual(commands[1].argv, ['/usr/bin/sed', '-i', 's/\\r$//', '--', './android/gradlew'])
  assert.deepEqual(commands[2], {
    cwd: projectDir,
    argv: ['/opt/appstudio/build-tools/flutter/bin/flutter', 'build', 'apk', '--debug', '--target-platform', 'android-x64'],
  })
  assert.deepEqual(artifact, {
    apkPath: projectDir + '/build/app/outputs/flutter-apk/app-debug.apk',
    applicationId: 'dev.appstudio.scene',
    launchActivity: 'dev.appstudio.scene.MainActivity',
    versionCode: 5,
  })
})

test('builds React Native with locked dependencies and checks for an embedded bundle', async () => {
  const { run, commands } = fakeRun()
  const artifact = await buildAndroidProject(run, { framework: 'react-native', projectDir })
  assert.deepEqual(commands[1].argv.slice(0, 2), ['/opt/appstudio/build-tools/node/bin/npm', 'ci'])
  assert.equal(commands[3].cwd, projectDir + '/android')
  assert(commands[3].argv.includes(':app:assembleDebug'))
  assert(commands[3].argv.includes('-PreactNativeArchitectures=x86_64'))
  assert(commands[3].argv.includes('/opt/appstudio/runtime/react-native.init.gradle'))
  assert(commands.some(({ argv }) => argv.includes('assets/index.android.bundle')))
  assert.equal(artifact.apkPath, projectDir + '/android/app/build/outputs/apk/debug/app-debug.apk')
})

test('builds native Android with the staged project wrapper', async () => {
  const { run, commands } = fakeRun()
  const artifact = await buildAndroidProject(run, { framework: 'android', projectDir })
  assert.deepEqual(commands[1].argv.slice(0, 3), ['/bin/bash', './gradlew', ':app:assembleDebug'])
  assert.equal(artifact.apkPath, projectDir + '/app/build/outputs/apk/debug/app-debug.apk')
})

test('refuses an escaped APK, a non-debuggable APK, and an APK without x86_64 support', async () => {
  for (const [overrides, expected] of [
    [{ apkPath: '/another/project/app-debug.apk' }, /inside the staged project/],
    [{ badging: validBadging.replace('application-debuggable', '') }, /debuggable/],
    [{ badging: validBadging.replace('x86_64', 'arm64-v8a') }, /x86_64/],
  ] as const) {
    await assert.rejects(buildAndroidProject(fakeRun(overrides).run, { framework: 'android', projectDir }), expected)
  }
})

test('reports failed build and bundle phases with diagnostics', async () => {
  for (const [framework, overrides, expected] of [
    ['android', { commandFailure: '/bin/bash' }, /Native Android build failed \(1\).*test command failure/],
    ['react-native', { bundleMissing: true }, /React Native embedded bundle check failed/],
  ] satisfies Array<[AndroidFramework, Parameters<typeof fakeRun>[0], RegExp]>) {
    await assert.rejects(buildAndroidProject(fakeRun(overrides).run, { framework, projectDir }), expected)
  }
})
