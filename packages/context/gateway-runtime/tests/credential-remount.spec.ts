/** A real child credential pipe verifies provider replacement and application isolation. */
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('retains launch authority across provider replacement without sharing it across applications', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const root = await mkdtemp(join(tmpdir(), 'dsh-credential-remount-'))
  const { publicKey } = generateKeyPairSync('ed25519')
  const credential = { version: 1, gatewayUrl: 'http://127.0.0.1:8899', organization: 'first-root',
    runtime: { kind: 'user', id: 7, generation: 7 }, token: 'synthetic-runtime-token',
    principalPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) }
  let child: ReturnType<typeof spawn> | undefined
  try {
    await mkdir(join(root, 'home'))
    await writeFile(join(root, 'second.json'), JSON.stringify({ ...credential, organization: 'second-root',
      runtime: { ...credential.runtime, generation: 8 } }), { mode: 0o600 })
    child = spawn(process.execPath, [
      ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
      fileURLToPath(new URL('./fixtures/credential-remount.mjs', import.meta.url)), mode, root,
    ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(20_000), env: {
      PATH: process.env.PATH, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
      DSH_GATEWAY_CREDENTIAL_FD: '3',
      TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) : undefined,
    } })
    const owned = child
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      owned.once('error', reject)
      owned.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    let stdout = '', stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const pipe = child.stdio[3]
    if (pipe === undefined || pipe === null || !('end' in pipe)) throw new Error('The child credential pipe is unavailable.')
    const written = new Promise<void>((resolve, reject) => {
      pipe.once('error', reject)
      pipe.end(JSON.stringify(credential), () => { resolve() })
    })
    const [{ code, signal }] = await Promise.all([closed, written])
    expect(signal, stderr).toBeNull()
    expect(code, stderr).toBe(0)
    expect(stdout).toBe(await readFile(new URL('./expected/credential-remount.jsonl', import.meta.url), 'utf8'))
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed
    }
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
