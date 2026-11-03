/** Native systemctl-client lifetime; the private CLI fixture never contacts a system manager. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SystemdLauncher, RuntimeLaunchCleanupError } from '../src/launcher.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
interface Witness { url: string; token: string }
async function fixture(hold: string, ignoreTerm = false) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-systemctl-')); roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'fixture.json'), JSON.stringify({ hold, ignoreTerm }))
  const binary = join(root, 'systemctl'), observation = join(root, 'ready.json'), calls = join(root, 'calls.jsonl')
  await writeFile(binary, `#!${process.execPath}\n${await readFile(new URL('./fixtures/systemctl-client.mjs', import.meta.url), 'utf8')}`)
  await chmod(binary, 0o700)
  await writeFile(join(root, 'id'), '#!/bin/sh\nprintf "1001\\n"\n')
  await chmod(join(root, 'id'), 0o700)
  vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`)
  vi.stubEnv('HGW_DATABASE_URL', 'postgres://synthetic.invalid/not-a-credential')
  const launcher = new SystemdLauncher({
    systemd: { usersRoot: join(root, 'users'), projectRuntimesRoot: join(root, 'runtimes'), projectPathRoots: [root],
      execStart: '/usr/bin/false', gatewayDir: join(root, 'gateway'), memoryMax: '1G', cpuQuota: '100%' },
    grantsProvider: () => [], credentialDir: join(root, 'credentials'), unitDir: root,
    commandTimeoutMs: 5000,
  })
  const runtime = { kind: 'user' as const, ownerId: 1, username: 'fixture', runtimeKey: 'fixture', systemUser: 'harness-fixture',
    port: 42001, homePath: join(root, 'users/fixture/home'), dshHome: join(root, 'users/fixture/dsh'),
    generation: 1, credentialHash: 'a'.repeat(64), gatewayCredential: '{}' }
  const witness = async (request: Promise<unknown>): Promise<Witness> => {
    let value: Witness | undefined, settled = false, result: unknown
    void request.then(value => { settled = true; result = value }, error => { settled = true; result = error })
    await expect.poll(async () => {
      try { value = JSON.parse(await readFile(observation, 'utf8')) as Witness; return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (settled) throw new Error('Control command settled before opening its witness listener', { cause: result })
        return false
      }
    }, { timeout: 20000 }).toBe(true)
    return value!
  }
  return { launcher, runtime, calls, witness }
}
async function readEndpoint(witness: Witness, release = false): Promise<string | undefined> {
  try { return await (await fetch(`${witness.url}/${release ? 'release/' : ''}${witness.token}`, { headers: { connection: 'close' } })).text() }
  catch (error) {
    if (error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause
      && ['ECONNREFUSED', 'ECONNRESET'].includes(String(error.cause.code))) return undefined
    throw error
  }
}

describe.skipIf(process.platform === 'win32')('native systemctl client ownership', () => {
  it('cancels and reaps a native control client that ignores SIGTERM', async () => {
    const f = await fixture('daemon-reload', true), controller = new AbortController()
    let settled = false, marker: Witness | undefined
    const pending = f.launcher.start({ ...f.runtime, signal: controller.signal }).then(value => ({ value }), (error: unknown) => ({ error }))
      .finally(() => { settled = true })
    try {
      marker = await f.witness(pending)
      controller.abort()
      await expect.poll(() => settled, { timeout: 2000 }).toBe(true)
      expect(await pending).toHaveProperty('error')
      expect(await readEndpoint(marker)).toBeUndefined()
    } finally {
      if (marker !== undefined) await readEndpoint(marker, true)
      const result = await pending
      if ('value' in result) await result.value.terminate(0)
      else if (result.error instanceof RuntimeLaunchCleanupError) await result.error.process.terminate(0)
    }
  })

  it.each(['daemon-reload', 'restart'])('cancels a live %s client and joins its listener closure', async operation => {
    const f = await fixture(operation), controller = new AbortController()
    let settled = false, marker: Witness | undefined
    const pending = f.launcher.start({ ...f.runtime, signal: controller.signal }).then(value => ({ value }), (error: unknown) => ({ error }))
      .finally(() => { settled = true })
    try {
      marker = await f.witness(pending)
      expect(await readEndpoint(marker)).toBe(marker.token)
      controller.abort()
      await expect.poll(() => settled, { timeout: 2000 }).toBe(true)
      const result = await pending
      expect(result).toHaveProperty('error')
      expect(await readEndpoint(marker)).toBeUndefined()
      if (operation === 'restart' && 'error' in result) expect(result.error).toBeInstanceOf(RuntimeLaunchCleanupError)
    } finally {
      if (marker !== undefined) await readEndpoint(marker, true)
      const result = await pending
      if ('value' in result) await result.value.terminate(0)
      else if (result.error instanceof RuntimeLaunchCleanupError) await result.error.process.terminate(0)
    }
  })

  it.each(['is-active', 'stop'])('bounds a stalled %s client without reporting stopped ownership', async operation => {
    const f = await fixture(operation), handle = f.launcher.attach(f.runtime)
    let settled = false, marker: Witness | undefined
    const request = operation === 'stop' ? handle.terminate(0) : handle.isAlive!()
    const result = request.then(() => ({ ok: true }), (error: unknown) => ({ error })).finally(() => { settled = true })
    try {
      marker = await f.witness(result)
      expect(await readEndpoint(marker)).toBe(marker.token)
      await expect.poll(() => settled, { timeout: 7000 }).toBe(true)
      expect(await result).toHaveProperty('error')
      expect(handle.hasExited()).toBe(false)
      expect(await readEndpoint(marker)).toBeUndefined()
    } finally { if (marker !== undefined) await readEndpoint(marker, true); await result }
  })

  it('excludes deployment credentials from actual native control commands', async () => {
    vi.stubEnv('LC_ALL', 'zh_CN.UTF-8')
    const f = await fixture('none'), handle = await f.launcher.start(f.runtime)
    try {
      const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { databasePresent: boolean; locale: string })
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every(call => !call.databasePresent)).toBe(true)
      expect(calls.every(call => call.locale === 'C')).toBe(true)
    } finally { await handle.terminate(0) }
  })
})
