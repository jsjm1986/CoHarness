import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/worker.cjs']
  .every(path => existsSync(join(packageRoot, path)))

async function node(script: string): Promise<unknown> {
  const { exitCode, stdout, stderr } = await execa(process.execPath, ['--input-type=module', '-e', script], {
    cwd: packageRoot,
    env: { NODE_PATH: undefined, NODE_OPTIONS: undefined, DSH_MANAGED_DATA_MANIFEST: undefined },
    stdin: 'ignore', timeout: 30_000, killSignal: 'SIGKILL', reject: false,
  })
  expect(exitCode, `stderr:\n${stderr}`).toBe(0)
  return JSON.parse(stdout.trim())
}

describe.skipIf(!built)('built migration verifier (plain node)', () => {
  it('publishes history and verifies it without runtime workspace imports', async () => {
    const script = `
      import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      import { Worker } from 'node:worker_threads'
      import { Context } from '@deepseek-ai/cordis'
      import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
      import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

      const root = await mkdtemp(join(tmpdir(), 'dsh-built-migration-'))
      const id = 'built-migration-worker'
      const directory = join(root, '_no-cwd', id)
      const ctx = new Context()
      let grant, requested
      const grantPromise = new Promise(resolve => { grant = resolve })
      const requestedPromise = new Promise(resolve => { requested = resolve })
      let admissions = 0, completions = 0
      class Budget extends ResourceBudget {
        async acquire() {
          admissions += 1
          requested()
          await grantPromise
          return { signal: new AbortController().signal,
            release: async () => { completions += 1 }, uncertain: async () => { throw new Error('unexpected uncertain verifier') } }
        }
      }
      try {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'session.jsonl'), JSON.stringify({
          type: 'session', version: 0, id, createdAt: 1, delegationDepth: 0,
        }) + '\\n')
        ctx.provide('resourceBudgetRequired', true)
        await ctx.plugin(Budget)
        await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
        let settled = false
        const pending = ctx.sessionPersistence.open(id, 'write')
        void pending.then(() => { settled = true }, () => { settled = true })
        await requestedPromise
        const waited = !settled
        grant()
        const handle = await pending
        await handle.close()
        await ctx.sessionPersistence.flush()
        const currentPath = join(directory, 'session.v7.jsonl')
        const header = JSON.parse((await readFile(currentPath, 'utf8')).trim())
        await mkdir(join(root, 'lib'))
        await copyFile('package.json', join(root, 'package.json'))
        const workerPath = join(root, 'lib', 'worker.cjs')
        await copyFile('lib/worker.cjs', workerPath)
        async function verify(expectedEventCount) {
          const worker = new Worker(workerPath, { workerData: {
            path: currentPath, compression: 'none', expectedId: id, expectedEventCount,
          } })
          try {
            return await new Promise((resolve, reject) => {
              worker.once('message', resolve)
              worker.once('error', reject)
              worker.once('exit', code => reject(new Error('verifier exited before a result: ' + code)))
            })
          } finally {
            await worker.terminate()
          }
        }
        const verified = await verify(0)
        const refused = await verify(1)
        console.log(JSON.stringify({ id: header.id, version: header.version,
          verified: verified.ok, refused: refused.ok, refusal: refused.message, waited, admissions, completions }))
      } finally {
        grant()
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    `
    expect(await node(script)).toEqual({
      id: 'built-migration-worker', version: 7, verified: true, refused: false,
      refusal: 'current session generation contains 0 events, expected 1',
      waited: true, admissions: 1, completions: 1,
    })
  })

  it('reports a missing published verifier as unavailable while preserving healthy history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-missing-verifier-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const moduleDirectory = await mkdtemp(join(packageRoot, 'lib', '.missing-verifier-'))
    onTestFinished(() => rm(moduleDirectory, { recursive: true, force: true }))
    const result = await node(`
      import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
      import { join } from 'node:path'
      import { pathToFileURL } from 'node:url'
      import { Context } from '@deepseek-ai/cordis'
      const root = ${JSON.stringify(root)}
      const moduleDirectory = ${JSON.stringify(moduleDirectory)}
      await copyFile('lib/index.js', join(moduleDirectory, 'index.js'))
      const backend = await import(pathToFileURL(join(moduleDirectory, 'index.js')).href)
      const id = 'missing-verifier'
      const directory = join(root, '_no-cwd', id)
      await mkdir(directory, { recursive: true })
      const sourcePath = join(directory, 'session.jsonl')
      const source = JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, delegationDepth: 0 }) + '\\n'
      await writeFile(sourcePath, source)
      const ctx = new Context()
      try {
        await ctx.plugin(backend, { root, compression: 'none' })
        const error = await ctx.sessionPersistence.open(id, 'write').catch(error => error)
        const current = await stat(join(directory, 'session.v7.jsonl')).then(() => true, error => {
          if (error.code !== 'ENOENT') throw error
          return false
        })
        console.log(JSON.stringify({ name: error.name, reason: error.reason,
          unchanged: await readFile(sourcePath, 'utf8') === source, current }))
      } finally { await ctx.fiber.dispose() }
    `)
    expect(result).toEqual({ name: 'ResourceAdmissionError', reason: 'unavailable', unchanged: true, current: false })
  })
})
