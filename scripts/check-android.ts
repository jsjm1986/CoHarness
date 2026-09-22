/** Build the ordinary Android variant; device checks require an explicitly named test emulator. */
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { assertAndroidBridgeEvidence, startAndroidBridgeFixture } from './android-bridge-fixture.ts'

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Android check failed: ${command} (${String(result.status ?? result.signal)})`)
}

const { values } = parseArgs({ options: { connected: { type: 'boolean' }, from: { type: 'string' } }, allowPositionals: false })
const root = resolve(import.meta.dirname, '..')
const shell = resolve(root, 'apps/android-shell')
const env: NodeJS.ProcessEnv = { ...process.env, DSH_ANDROID_WEB_URL: 'http://127.0.0.1:38761/' }
if (values.connected && !/^emulator-\d+$/.test(env.DSH_ANDROID_TEST_SERIAL ?? '')) {
  throw new Error('check-android: connected tests require DSH_ANDROID_TEST_SERIAL=emulator-<port>; attached personal devices are never selected')
}
if (values.connected) {
  const directory = resolve(root, values.from ?? '.artifacts/android/apk')
  const serial = env.DSH_ANDROID_TEST_SERIAL
  if (serial === undefined) throw new Error('check-android: no test emulator selected')
  for (const apk of ['debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk']) {
    run('adb', ['-s', serial, 'install', '-r', resolve(directory, apk)], root, env)
  }
  const fixture = await startAndroidBridgeFixture()
  try {
    run('adb', ['-s', serial, 'reverse', 'tcp:38761', `tcp:${String(fixture.port)}`], root, env)
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('adb', ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
        'com.coharness.test/androidx.test.runner.AndroidJUnitRunner'], { cwd: root, env, timeout: 120_000 })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.pipe(process.stderr)
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code !== 0) reject(new Error(`Android instrumentation exited ${String(code ?? signal)}`))
        else resolve(stdout)
      })
    })
    process.stdout.write(output)
    assertAndroidBridgeEvidence(output)
  } finally {
    try { run('adb', ['-s', serial, 'reverse', '--remove', 'tcp:38761'], root, env) }
    finally { await fixture.close() }
  }
  process.exit(0)
}
for (const args of [['--dir', shell, 'run', 'build'], ['--dir', shell, 'run', 'cap:sync']]) {
  const invocation = pnpmInvocation(args)
  run(invocation.command, invocation.args, root, env)
}
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
// The wrapper's Windows .bat launcher requires cmd; pnpm children remain shell-free.
const tasks = [':app:assembleDebug', ':app:assembleDebugAndroidTest', ':app:lintDebug', ':app:testDebugUnitTest']
if (process.platform === 'win32') run('cmd.exe', ['/d', '/c', wrapper, '--no-daemon', ...tasks], resolve(shell, 'android'), env)
else run(wrapper, ['--no-daemon', ...tasks], resolve(shell, 'android'), env)
