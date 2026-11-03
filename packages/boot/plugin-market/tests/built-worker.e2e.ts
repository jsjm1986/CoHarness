/**
 * Built-artifact guard: plain `node` runs the published `lib/index.js`, whose search spawns the bundled
 * `lib/worker.cjs`, and the Worker bundle alone parses bodies outside any `node_modules`. Skips until a build produces
 * both artifacts.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/worker.cjs'].every(path => existsSync(join(packageRoot, path)))

async function node(script: string): Promise<unknown> {
  const { exitCode, stdout, stderr } = await execa(process.execPath, ['--input-type=module', '-e', script], {
    cwd: packageRoot, env: { NODE_PATH: undefined, NODE_OPTIONS: undefined },
    stdin: 'ignore', timeout: 30_000, killSignal: 'SIGKILL', reject: false,
  })
  expect(exitCode, `stderr:\n${stderr}`).toBe(0)
  return JSON.parse(stdout.trim())
}

describe.skipIf(!built)('built index parsing (plain node)', () => {
  it('searches a valid index and reports an invalid one through the bundled Worker', async () => {
    const result = await node(`
      import { Context, Service } from '@deepseek-ai/cordis'
      import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
      import PluginMarket from './lib/index.js'

      const bodies = {
        'https://m.example/valid.json': { format: 1, title: 'M', plugins: [{ name: 'p', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' } }] }] },
        'https://m.example/invalid.json': { format: 2 },
      }
      globalThis.fetch = async (url) => new Response(JSON.stringify(bodies[url]))
      let grant
      let requested
      const waiting = new Promise(resolve => { grant = resolve })
      const entering = new Promise(resolve => { requested = resolve })
      let admissions = 0, completions = 0
      class Budget extends ResourceBudget {
        async acquire() {
          admissions += 1
          if (admissions === 1) { requested(); await waiting }
          return { signal: new AbortController().signal, release: async () => { completions += 1 },
            uncertain: async () => { throw new Error('unexpected uncertain parser') } }
        }
      }
      class Manager extends Service {
        constructor(ctx) { super(ctx, 'pluginManager') }
        listBundles() { return Promise.resolve([]) }
        listVersionExemptions() { return { exemptions: {}, warnings: [] } }
      }
      const ctx = new Context()
      try {
        ctx.provide('resourceBudgetRequired', true)
        await ctx.plugin(Budget)
        await ctx.plugin(Manager)
        await ctx.plugin(PluginMarket, { indexes: Object.keys(bodies) })
        const query = { sort: { kind: 'index' }, offset: 0, limit: 10 }
        let settled = false
        const pending = ctx.pluginMarket.search('https://m.example/valid.json', query)
        void pending.then(() => { settled = true }, () => { settled = true })
        await entering
        const waited = !settled
        grant()
        const valid = await pending
        const invalid = await ctx.pluginMarket.search('https://m.example/invalid.json', query).catch(error => error)
        console.log(JSON.stringify({ entries: valid.entries.map(entry => entry.name), code: invalid.code, details: invalid.details,
          waited, admissions, completions }))
      } finally {
        grant()
        await ctx.fiber.dispose()
      }
    `)
    expect(result).toEqual({
      entries: ['p'],
      code: 'plugin-market/invalid-index',
      details: { url: 'https://m.example/invalid.json', path: '$.format', reason: 'must be 1' },
      waited: true, admissions: 2, completions: 2,
    })
  })

  it('runs the Worker bundle without workspace packages and refuses a malformed request', async () => {
    const result = await node(`
      import { copyFile, mkdtemp, rm } from 'node:fs/promises'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      import { Worker } from 'node:worker_threads'

      const root = await mkdtemp(join(tmpdir(), 'dsh-built-market-worker-'))
      const path = join(root, 'worker.cjs')
      const run = (workerData, transferList = []) => new Promise((resolve, reject) => {
        const worker = new Worker(path, { workerData, transferList })
        let settled = false
        const finish = result => {
          if (settled) return
          settled = true
          void worker.terminate().then(() => { resolve(result) }, reject)
        }
        worker.once('message', (value) => { finish({ message: value }) })
        worker.once('error', (error) => { finish({ error: error.message }) })
        worker.once('exit', (code) => { finish({ exit: code }) })
      })
      try {
        await copyFile('lib/worker.cjs', path)
        const body = new TextEncoder().encode(JSON.stringify({ format: 1, title: 'M', plugins: [{ name: 'p', icon: 'p.svg', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' } }] }] }))
        const valid = await run({ body, url: 'https://m.example/dsh/index.json' }, [body.buffer])
        const malformed = await run({ body: 'x', url: 1 })
        console.log(JSON.stringify({ icon: valid.message.index.plugins[0].icon, malformed }))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    `)
    expect(result).toEqual({ icon: 'https://m.example/dsh/p.svg', malformed: { error: 'index parser request is malformed' } })
  })
})
