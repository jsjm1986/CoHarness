/** PostgreSQL command pipes settle when a catalog reader exits before consuming the dump. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { createDeploymentCommands } from '../src/deployment-commands.ts'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function verifyWithReader(exitCode: number, missingDump = false): Promise<{ stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gateway-dump-pipe-'))
  roots.push(root)
  const dump = join(root, 'large.dump'), reader = join(root, 'reader.mjs'), invoke = join(root, 'invoke.mjs')
  if (!missingDump) {
    await writeFile(dump, '')
    await truncate(dump, 16 * 1024 * 1024)
  }
  await writeFile(reader, `process.stdin.once('data', () => {
    process.stderr.write('fixture reader finished\\n', () => process.exit(${String(exitCode)}))
  })\n`)
  await writeFile(invoke, `import { createDeploymentCommands } from ${JSON.stringify(new URL('../src/deployment-commands.ts', import.meta.url).href)}
    const command = [process.execPath, ${JSON.stringify(reader)}]
    try {
      await createDeploymentCommands(command, command).verifyDump(${JSON.stringify(dump)})
      console.log('verified')
    } catch (error) {
      console.log(error.message)
      process.exitCode = 1
    }\n`)
  return execute(process.execPath, ['--import', import.meta.resolve('tsx/esm'), invoke], { timeout: 10_000, maxBuffer: 64 * 1024 })
}

it('accepts successful early input closure after the child has exited', async () => {
  expect((await verifyWithReader(0)).stdout.trim()).toBe('verified')
})

it('reports the nonzero exit instead of masking it or waiting for input finish', async () => {
  await expect(verifyWithReader(7)).rejects.toMatchObject({
    code: 1, killed: false,
    stdout: expect.stringContaining('deployment command failed (exit 7)'),
  })
})

it('rejects a missing input file without leaving the command waiting for input', async () => {
  await expect(verifyWithReader(0, true)).rejects.toMatchObject({
    code: 1, killed: false, stdout: expect.stringContaining('ENOENT'),
  })
})

it('waits for the reader process to exit after the operation loses its lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-restore-cancel-'))
  roots.push(root)
  const dump = join(root, 'fixture.dump'), reader = join(root, 'reader.mjs'), pidFile = join(root, 'pid')
  await writeFile(dump, 'fixture')
  await writeFile(reader, `import { writeFileSync } from 'node:fs'
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
    process.stdin.resume()
    setInterval(() => {}, 1000)
  `)
  const controller = new AbortController(), command = [process.execPath, reader]
  const reading = createDeploymentCommands(command, command).verifyDump(dump, controller.signal)
  const rejected = expect(reading).rejects.toThrow()
  try {
    let pid = 0
    await vi.waitFor(async () => { pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0) })
    controller.abort(new Error('fixture lease lost'))
    await rejected
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    controller.abort()
    await Promise.allSettled([reading])
  }
})
