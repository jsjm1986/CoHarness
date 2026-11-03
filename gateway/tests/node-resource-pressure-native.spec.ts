/** The native pressure-command substitution keeps real execFile timeout and close semantics. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NodeResourcePressure } from '../src/node-resource-pressure.ts'

const native = vi.hoisted(() => ({ args: undefined as string[] | undefined, cpu: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(actual.execFile)
  const redirected = (args: unknown[]): unknown[] => args[0] === '/usr/sbin/sysctl' && native.args !== undefined
    ? [process.execPath, native.args, ...args.slice(2)] : args
  const execFile = Object.assign((...args: unknown[]) => Reflect.apply(actual.execFile, undefined, redirected(args)), {
    [promisify.custom]: (...args: unknown[]) => Reflect.apply(execute, undefined, redirected(args)),
  })
  return { ...actual, execFile }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, cpus: () => [{ model: 'fixture', speed: 1000,
    times: { user: ++native.cpu * 100, nice: 0, sys: 0, idle: native.cpu * 100, irq: 0 } }] }
})
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platform); native.args = undefined })

async function endpoint(marker: { url: string; token: string }, release = false): Promise<string | undefined> {
  try { return await (await fetch(`${marker.url}/${release ? 'release/' : ''}${marker.token}`, { headers: { connection: 'close' } })).text() }
  catch (error) {
    if (error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause
      && ['ECONNREFUSED', 'ECONNRESET'].includes(String(error.cause.code))) return undefined
    throw error
  }
}
it.skipIf(process.platform === 'win32')('joins a pressure helper that ignores SIGTERM when its sample deadline expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-pressure-native-'))
  const program = join(root, 'probe.mjs')
  await writeFile(program, await readFile(new URL('./fixtures/systemctl-client.mjs', import.meta.url), 'utf8'))
  await writeFile(join(root, 'fixture.json'), JSON.stringify({ hold: 'pressure', ignoreTerm: true }))
  native.args = [program, 'pressure']
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const published: unknown[] = [], failed: unknown[] = []
  const sampler = new NodeResourcePressure({ sampleMs: 2000, staleMs: 10_000, cpuTarget: 0.85,
    eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1 }, async sample => { published.push(sample) }, error => { failed.push(error) }, () => true)
  let marker: { url: string; token: string } | undefined, closing: Promise<void> | undefined, timer: NodeJS.Timeout | undefined
  sampler.start()
  try {
    await expect.poll(async () => {
      try { marker = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) as typeof marker; return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    }, { timeout: 20_000 }).toBe(true)
    expect(await endpoint(marker!)).toBe(marker!.token)
    closing = sampler.dispose()
    await Promise.race([closing, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Pressure helper outlived its sample deadline')), 3500) })])
    expect(await endpoint(marker!)).toBeUndefined()
    expect(failed).toHaveLength(1)
    expect(published).toHaveLength(0)
  } finally {
    clearTimeout(timer)
    if (marker !== undefined) await endpoint(marker, true)
    await closing
    await sampler.dispose()
    if (marker !== undefined) await expect.poll(() => endpoint(marker!), { timeout: 10_000 }).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  }
})
