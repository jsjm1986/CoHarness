/** Target-owned scratch operations and versioned captures do not read source paths on the Host. */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { PosixRecorderExecution } from '../src/execution.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-execution-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem)
  cleanups.push(() => ctx.fiber.dispose())
  return { root, ctx, execution: new PosixRecorderExecution(ctx.fs, ctx.subprocess, root, 30_000) }
}

const signal = new AbortController().signal
describe.skipIf(process.platform === 'win32')('POSIX snapshot execution storage', () => {
  it('owns private directories and leaves the repository index unchanged, including shell metacharacters', async () => {
    const { root, execution } = await setup()
    expect(await execution.canonical(root)).toBe(root)
    const prefix = join(root, "scratch ' $() -")
    const directory = await execution.temporary(prefix, signal)
    const objects = join(directory, 'objects')
    await execution.mkdir(objects, signal)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    const source = join(root, 'index')
    await writeFile(source, Uint8Array.of(0, 1, 255, 10))
    const destination = join(directory, 'index')
    await execution.copyIndex(source, destination, signal)
    expect(await readFile(destination)).toEqual(await readFile(source))
    await execution.copyIndex(join(root, 'absent'), join(directory, 'absent'), signal)
    await expect(stat(join(directory, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(execution.remove(root)).rejects.toThrow('unowned')
    await execution.remove(directory)
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source)).toEqual(Buffer.from([0, 1, 255, 10]))
  })

  it('reads target environment paths and refuses invalid or truncated target observations', async () => {
    const { root, ctx, execution } = await setup()
    const targetTemp = join(root, 'target temp')
    await mkdir(targetTemp)
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const env = { HOME: root, TMPDIR: targetTemp }
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec, env: { ...spec.env, ...env } }))
    const paths = await execution.paths(signal)
    expect(paths).toMatchObject({ cwd: root, home: root, scratchRoot: targetTemp })
    expect(paths.temporaryRoots).toEqual(expect.arrayContaining([targetTemp, '/tmp']))
    env.HOME = 'relative'
    await expect(execution.paths(signal)).rejects.toThrow('absolute target')
    env.HOME = `/${'x'.repeat(32 * 1024)}`
    await expect(execution.paths(signal)).rejects.toThrow('storage operation failed')
    await expect(execution.temporary(join(root, 'missing', 'prefix-'), signal)).rejects.toThrow('storage operation failed')
  })

  it('rejects a malformed directory response without deleting an unowned path', async () => {
    const { root, ctx, execution } = await setup()
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'mktemp'), '#!/bin/sh\nprintf /unexpected-target')
    await chmod(join(bin, 'mktemp'), 0o700)
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec, env: { PATH: bin } }))
    await expect(execution.temporary(join(root, 'scratch-'), signal)).rejects.toThrow('Invalid workspace snapshot directory')
    await expect(execution.remove('/unexpected-target')).rejects.toThrow('unowned')
  })

  it('captures bounded complete bytes, absence and binary data without retaining mutable source references', async () => {
    const { root, ctx, execution } = await setup()
    const directory = join(root, 'captures')
    const source = join(root, 'source')
    expect(await execution.capture(source, directory, 8, signal)).toEqual({ kind: 'absent' })
    expect(await execution.capture(root, directory, 8, signal)).toBeUndefined()
    await writeFile(source, 'before\n')
    const captured = await execution.capture(source, directory, 8, signal)
    expect(captured).toMatchObject({ kind: 'file', binary: false })
    await writeFile(source, 'after\n')
    expect(await readFile((captured as { file: string }).file, 'utf8')).toBe('before\n')
    await writeFile(source, Buffer.from([0, 1, 2]))
    expect(await execution.capture(source, directory, 8, signal)).toMatchObject({ kind: 'file', binary: true })
    await writeFile(source, '123456789')
    expect(await execution.capture(source, directory, 8, signal)).toEqual({ kind: 'oversized' })
    const original = ctx.fs.stat.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'stat').mockImplementation(async (target, cancellation) => {
      const info = await original(target, cancellation)
      return info === undefined ? undefined : { version: info.version, type: info.type }
    })
    expect(await execution.capture(source, directory, 8, signal)).toEqual({ kind: 'oversized' })
    await writeFile(source, '')
    expect(await execution.capture(source, directory, 8, signal)).toMatchObject({ kind: 'file', binary: false })
  })

  it('refuses a source changed between windows and stops a cancelled scratch operation', async () => {
    const { root, ctx, execution } = await setup()
    const source = join(root, 'large')
    await writeFile(source, 'a'.repeat(100_000))
    const read = ctx.fs.readByteRange.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'readByteRange').mockImplementation(async (target, window, cancellation) => {
      const bytes = await read(target, window, cancellation)
      if (window.offset === 0) await writeFile(source, 'changed')
      return bytes
    })
    await expect(execution.capture(source, join(root, 'captures'), 150_000, signal)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(execution.temporary(join(root, 'cancelled-'), AbortSignal.abort())).rejects.toThrow()
    expect(await execution.gitAvailable('/usr/bin/git', signal)).toBe(true)
  })
})
