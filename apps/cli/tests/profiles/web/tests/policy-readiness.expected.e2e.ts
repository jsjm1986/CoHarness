/** Signed readiness through the shipped CLI/Web profile and real Loader lifecycle. */
import { spawn } from 'node:child_process'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveExampleLaunch, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url))

it('requires configured policy activation before signed managed Web readiness', async (test) => {
  const mode = resolveExampleMode()
  const root = await mkdtemp(join(tmpdir(), 'managed-policy-readiness-'))
  const coordinator = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ nextSequence: 1, policy: {
      sampleMs: 20, staleMs: 500, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
      maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 64 * 1024, maxWaitMs: 10_000,
    } }))
  })
  await new Promise<void>(resolve => coordinator.listen(0, '127.0.0.1', resolve))
  const address = coordinator.address()
  if (address === null || typeof address === 'string') throw Error('Expected coordinator port')
  const key = generateKeyPairSync('ed25519')
  const credential = { version: 1, gatewayUrl: `http://127.0.0.1:${String(address.port)}`, organization: 'fixture',
    runtime: { kind: 'user', id: 7, generation: 1 }, token: 'fixture-private-readiness-token',
    principalPublicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const credentialFile = join(root, 'credential.json'), plugin = join(root, 'policy.mjs'), patch = join(root, 'policy.patch.yml')
  await writeFile(credentialFile, JSON.stringify(credential), { mode: 0o600 })
  await writeFile(plugin, 'export function apply() {}\n')
  const launch = resolveExampleLaunch({ mode, sourceImport: 'tsx/esm', tsconfigPath: join(repo, 'tsconfig.base.json'), srcBin: join(repo, 'apps/cli/src/bin.ts'),
    configArgs: ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    env: { DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
      DSH_GATEWAY_CREDENTIAL_FILE: credentialFile, DSH_GATEWAY_CREDENTIAL_FD: undefined,
      DSH_MANAGED_DATA_MANIFEST: undefined, DEEPSEEK_API_KEY: 'keyless-no-model-calls', NODE_OPTIONS: undefined, NODE_PATH: undefined },
  })
  const face = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
  const budgetFace = mode === 'src' ? 'src/resource-budget.ts' : 'lib/resource-budget.js'
  await writeFile(patch, JSON.stringify([{ id: 'hmr', disabled: true }, { insert: [
    { id: 'gateway-runtime', name: pathToFileURL(join(repo, 'packages/context/gateway-runtime', face)).href,
      config: { requiredPlugins: ['policy-acceptance'] } },
    { id: 'gateway-resource-budget', name: pathToFileURL(join(repo, 'packages/context/gateway-runtime', budgetFace)).href,
      config: { requestTimeoutMs: 5000, cleanupTimeoutMs: 10000 } },
    { id: 'readiness-observer', name: new URL('./fixtures/policy-readiness.mjs', import.meta.url).href,
      config: { plugin: pathToFileURL(plugin).href, missingPlugin: pathToFileURL(join(root, 'missing.mjs')).href } },
  ] }, { id: 'llm', inject: ['resourceBudget'] }, { id: 'subprocess', inject: ['resourceBudget'] }]))
  const child = spawn(launch.command, launch.args, { cwd: root, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let port: number | undefined, output = '', failure: Error | undefined, forced = false
  const completion = Promise.withResolvers<undefined>()
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>()
  child.once('error', (error) => { failure = error; completion.resolve(undefined) })
  child.once('close', () => { completion.resolve(undefined) })
  for (const stream of [child.stdout, child.stderr]) stream!.on('data', (data) => { output = (output + String(data)).slice(-20000) })
  child.on('message', (message: { port?: number; changed?: string; error?: string }) => {
    port ??= message.port
    if (message.error !== undefined) { failure = Error(message.error); for (const request of pending.values()) request.reject(failure) }
    if (message.changed !== undefined) { pending.get(message.changed)?.resolve(undefined); pending.delete(message.changed) }
  })
  const stopChild = async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    const timer = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 20000)
    try { await completion.promise } finally { clearTimeout(timer) }
    expect(forced).toBe(false)
  }
  test.onTestFinished(async () => {
    try { await stopChild() } finally {
      coordinator.closeAllConnections()
      try {
        if (coordinator.listening) await new Promise<void>((resolve, reject) =>
          coordinator.close((error) =>{  error === undefined ? resolve() : reject(error) }))
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  await expect.poll(() => {
    if (failure !== undefined || child.exitCode !== null) throw failure ?? Error(output)
    return port
  }, { timeout: 60000 }).toBeTypeOf('number')
  const change = async (command: string) => {
    const result = Promise.withResolvers<undefined>(); pending.set(command, result)
    child.send(command, (error) => { if (error !== null) result.reject(error) })
    await result.promise
  }
  const nonce = 'fixture-readiness'
  const proof = (kind: string) => createHmac('sha256', credential.token).update([
    'dsh-gateway-readiness-v1', kind, nonce, credential.runtime.kind, String(credential.runtime.id), String(credential.runtime.generation),
  ].join('\u0000')).digest('base64url')
  const transcript: object[] = []
  const inspect = async (phase: string, status: number) => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/internal/gateway/readiness`, {
      headers: { 'x-dsh-gateway-readiness-nonce': nonce, 'x-dsh-gateway-readiness-request': proof('request') }, signal: AbortSignal.timeout(5000),
    })
    const body = await response.json() as { error?: string; proof?: string }
    expect(response.status).toBe(status)
    if (status === 200) expect(body.proof).toBe(proof('response'))
    transcript.push({ phase, status: response.status, error: body.error ?? null, proofVerified: status === 200 })
  }
  await inspect('missing', 503)
  await change('fail'); await inspect('import-failed', 503)
  await change('remove'); await change('activate'); await inspect('active', 200)
  await change('disable'); await inspect('disabled', 503)
  await change('enable'); await inspect('restored', 200)
  await change('remove'); await inspect('removed', 503)
  expect(JSON.stringify(transcript, null, 2) + '\n').toBe(await readFile(new URL('./snapshots/policy-readiness/expected.json', import.meta.url), 'utf8'))
})
