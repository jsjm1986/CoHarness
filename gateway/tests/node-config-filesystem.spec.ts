/** Node configuration reads reject special files and writers preserve foreign temporary entries. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { NodeConfigurationStore, readNodeConfiguration, writeNodeConfiguration } from '../src/node-config-store.ts'
import { isolatedNodeConfigurationAuthority } from './node-config-fixture.ts'
import { testConfig, testEnvironment } from './test-config.ts'

const io = vi.hoisted(() => ({ uuid: undefined as ReturnType<typeof import('node:crypto')['randomUUID']> | undefined,
  growFile: undefined as string | undefined, writeFailure: undefined as Error | undefined, replaceTempAfterRename: false }))
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: () => io.uuid ?? actual.randomUUID() }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, async rename(...args: Parameters<typeof actual.rename>) {
    await actual.rename(...args)
    if (io.replaceTempAfterRename) { io.replaceTempAfterRename = false; await actual.writeFile(args[0], 'foreign successor', { mode: 0o600 }) }
  }, async open(...args: Parameters<typeof actual.open>) {
    const handle = await actual.open(...args)
    if (String(args[0]).endsWith('.tmp') && io.writeFailure !== undefined) {
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => { throw io.writeFailure })
    }
    if (String(args[0]) === io.growFile) {
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const info = await stat(), file = io.growFile!
        io.growFile = undefined
        await actual.appendFile(file, ' '.repeat(1024 * 1024 + 1))
        return info
      })
    }
    return handle
  } }
})
const directories: string[] = []
afterEach(async () => { io.uuid = undefined; io.growFile = undefined; io.writeFailure = undefined; io.replaceTempAfterRename = false
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'node-config-filesystem-')); directories.push(dir); return dir
}

it('preserves a foreign temporary file when exclusive configuration acquisition fails', async () => {
  const root = await directory(), env = testEnvironment(root, { HGW_STATE_ROOT: root }), cfg = testConfig(root, env)
  const store = new NodeConfigurationStore({ organizationId: 'org', nodeId: 'node' }, cfg, env, isolatedNodeConfigurationAuthority)
  await store.initialize()
  const current = (await readNodeConfiguration(cfg.nodeConfigFile, env))!, before = await readFile(cfg.nodeConfigFile, 'utf8')
  io.uuid = '00000000-0000-4000-8000-000000000000'
  const temporary = `${cfg.nodeConfigFile}.${io.uuid}.tmp`
  await writeFile(temporary, 'foreign operation', { mode: 0o600 })
  await expect(writeNodeConfiguration(cfg.nodeConfigFile, { ...current, revision: current.revision + 1 }))
    .rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(temporary, 'utf8')).toBe('foreign operation')
  expect(await readFile(cfg.nodeConfigFile, 'utf8')).toBe(before)
})

it('bounds actual configuration bytes when a file grows after its metadata is inspected', async () => {
  const root = await directory(), env = testEnvironment(root, { HGW_STATE_ROOT: root }), cfg = testConfig(root, env)
  const store = new NodeConfigurationStore({ organizationId: 'org', nodeId: 'node' }, cfg, env, isolatedNodeConfigurationAuthority)
  await store.initialize()
  io.growFile = cfg.nodeConfigFile
  await expect(readNodeConfiguration(cfg.nodeConfigFile, env)).rejects.toMatchObject({ status: 409, message: 'node-configuration-file-must-be-private' })
})

it('cleans an acquired staging failure while retaining the committed configuration', async () => {
  const root = await directory(), env = testEnvironment(root, { HGW_STATE_ROOT: root }), cfg = testConfig(root, env)
  const store = new NodeConfigurationStore({ organizationId: 'org', nodeId: 'node' }, cfg, env, isolatedNodeConfigurationAuthority)
  await store.initialize()
  const current = (await readNodeConfiguration(cfg.nodeConfigFile, env))!, before = await readFile(cfg.nodeConfigFile, 'utf8')
  const failure = Object.assign(new Error('Injected staging write failure'), { code: 'EIO' }); io.writeFailure = failure
  await expect(writeNodeConfiguration(cfg.nodeConfigFile, { ...current, revision: current.revision + 1 })).rejects.toBe(failure)
  expect(await readFile(cfg.nodeConfigFile, 'utf8')).toBe(before)
  expect(await readdir(root)).toEqual(['node-config.json'])
})

it('preserves a foreign successor at the old staging path after publication', async () => {
  const root = await directory(), env = testEnvironment(root, { HGW_STATE_ROOT: root }), cfg = testConfig(root, env)
  const store = new NodeConfigurationStore({ organizationId: 'org', nodeId: 'node' }, cfg, env, isolatedNodeConfigurationAuthority)
  await store.initialize()
  const current = (await readNodeConfiguration(cfg.nodeConfigFile, env))!
  io.uuid = '00000000-0000-4000-8000-000000000000'; io.replaceTempAfterRename = true
  await writeNodeConfiguration(cfg.nodeConfigFile, { ...current, revision: current.revision + 1 })
  expect(await readFile(`${cfg.nodeConfigFile}.${io.uuid}.tmp`, 'utf8')).toBe('foreign successor')
  expect((await readNodeConfiguration(cfg.nodeConfigFile, env))!.revision).toBe(current.revision + 1)
})

it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for another process to open its writer', async () => {
  const root = await directory(), file = join(root, 'node-config.json')
  await promisify(execFile)('mkfifo', ['-m', '600', file], { timeout: 5_000 })
  const result = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
    fileURLToPath(new URL('./fixtures/node-config-fifo-reader.mjs', import.meta.url)), file,
  ], { timeout: 10_000, killSignal: 'SIGKILL', cwd: root, env: { ...process.env,
    NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../../tsconfig.json'),
    DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
  } })
  expect(result.stdout).toBe('reading-node-configuration\n'+JSON.stringify({ status: 409, error: 'node-configuration-file-must-be-private' })+'\n')
}, 15_000)
