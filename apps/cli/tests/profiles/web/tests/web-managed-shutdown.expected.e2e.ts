/** Keyless managed Web shutdown via the real CLI, Agent loop, and JSONL backend. */
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, onTestFinished } from 'vitest'

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url))

it.each([
  { transport: 'ipc', failure: undefined },
  { transport: 'ipc', failure: undefined, graceMs: 15_000 },
  { transport: 'signal', failure: undefined },
  { transport: 'ipc', failure: 'checkpoint' },
  { transport: 'ipc', failure: 'scope cleanup' },
  { transport: 'ipc', failure: 'timeout' },
  { transport: 'signal', failure: 'forced' },
] as const)('reports planned Web shutdown after the final checkpoint ($transport, failure $failure, grace $graceMs)', async (scenario) => {
  const { transport, failure } = scenario
  const graceMs = 'graceMs' in scenario ? scenario.graceMs : undefined
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-web-shutdown-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const patch = join(root, 'shutdown.patch.yml')
  const result = join(root, 'scope.json')
  const receipt = join(root, 'shutdown.receipt')
  const sessions = join(root, 'sessions')
  const credential = join(root, 'credential.json')
  const token = 'fixture-shutdown-token'
  await writeFile(credential, JSON.stringify({ token }), { mode: 0o600 })
  await writeFile(patch, JSON.stringify([
    { id: 'hmr', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
    { insert: [{ name: new URL('./fixtures/agent-shutdown.mjs', import.meta.url).href,
      config: { root, result, running: true, planned: true, checkpointFails: failure === 'checkpoint', scopeFails: failure === 'scope cleanup' } }] },
  ]))
  const launch = resolveExampleLaunch({ sourceImport: 'tsx/esm', srcBin: join(repo, 'apps/cli/src/bin.ts'),
    tsconfigPath: join(repo, 'tsconfig.base.json'), configArgs: ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'],
    env: {
      DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
      DSH_GATEWAY_CREDENTIAL_FILE: credential, DSH_GATEWAY_CREDENTIAL_FD: undefined,
      DSH_MANAGED_DATA_MANIFEST: undefined, DSH_GATEWAY_SHUTDOWN_RECEIPT: receipt,
    },
  })
  const child = spawn(launch.command, launch.args, { cwd: root, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let diagnostics = ''
  child.stdout?.on('data', (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-20_000) })
  child.stderr?.on('data', (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-20_000) })
  const complete = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  void complete.catch(() => {})
  const stopChild = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await complete
  }
  onTestFinished(stopChild)
  const received = new Map<string, string | undefined>()
  child.on('message', (message: { kind?: string; outcome?: string }) => {
    if (message.kind !== undefined) received.set(message.kind, message.outcome)
  })
  const waitFor = (kind: string, timeout: number): Promise<void> => expect.poll(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Web exited before ${kind}\n${diagnostics}`)
    return received.has(kind)
  }, { timeout }).toBe(true)
  const requestStop = (): void => {
    if (transport === 'ipc') child.send(graceMs === undefined ? { kind: 'dsh-runtime-stop' } : { kind: 'dsh-runtime-stop', graceMs })
    else if (process.platform === 'win32') child.send('signal-fixture-stop')
    else child.kill('SIGTERM')
  }
  try {
    await waitFor('dsh-runtime-stop-ready', 60_000)
    await waitFor('shutdown-fixture-ready', 60_000)
    requestStop()
    await waitFor('shutdown-fixture-aborted', 3_000)
    if (graceMs !== undefined) {
      await expect(Promise.race([
        complete.then(() => 'exited'),
        new Promise(resolve => setTimeout(() => { resolve('waiting') }, 5_250)),
      ])).resolves.toBe('waiting')
    }
    expect(received.has('dsh-runtime-stopped')).toBe(false)
    if (failure === 'forced') requestStop()
    else if (failure !== 'timeout') child.send('release-fixture-turn')
    const exit = await complete
    expect(exit.signal, diagnostics).toBeNull()
    if (failure === 'checkpoint' || failure === 'scope cleanup') {
      expect(exit.code, diagnostics).toBe(1)
      expect(received.get('dsh-runtime-stopped')).toBe('failed')
      expect(diagnostics).toContain(`shutdown fixture ${failure} failed`)
      return
    }
    if (failure === 'timeout') {
      expect(exit.code, diagnostics).toBe(1)
      expect(received.get('dsh-runtime-stopped')).toBe('timeout')
      return
    }
    expect(exit.code, diagnostics).toBe(failure === 'forced' ? 83 : transport === 'ipc' ? 0 : 80)
    let outcome = received.get('dsh-runtime-stopped')
    if (transport === 'signal') {
      const marker = await readFile(receipt, 'utf8')
      outcome = failure === 'forced' ? 'forced' : 'confirmed'
      const proof = createHmac('sha256', token).update(['dsh-gateway-shutdown-v1', basename(receipt), outcome].join('\0')).digest('base64url')
      expect(marker).toBe(`${outcome}\t${proof}\n`)
    }
    if (failure === 'forced') return

    const verify = new Context()
    try {
      await verify.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none' })
      await using reader = await verify.sessionPersistence.open(SessionId('shutdown-fixture'), 'read')
      const { events } = await reader.read()
      const turnEnd = events.findLast(event => event.type === 'turn/end')?.data.reason
      const evidence = JSON.parse(await readFile(result, 'utf8')) as { status: string; cancelled: unknown[]; nextStep: unknown[]; nextTurn: unknown[] }
      const transcript = { outcome, turnEnd, idle: evidence.status, cancelled: evidence.cancelled.length,
        nextStep: evidence.nextStep.length, nextTurn: evidence.nextTurn.length }
      expect(JSON.stringify(transcript, null, 2) + '\n').toBe(await readFile(new URL('./snapshots/managed-shutdown/expected.json', import.meta.url), 'utf8'))
    } finally { await verify.fiber.dispose() }
  } finally { await stopChild() }
})
