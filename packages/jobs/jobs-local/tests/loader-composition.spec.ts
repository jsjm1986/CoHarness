import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('jobs-local through a real Loader composition', () => {
  it('applies the provider-owned admission config from a Cordis row', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jobs-local-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-jobs-local'",
      '  config:',
      '    maxConcurrentJobsPerOwner: 1',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-jobs-local') return LocalJobRegistry
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.jobs).toBeInstanceOf(LocalJobRegistry)
    context.jobs.attachController('loader-test')
    let settle!: (outcome: { status: 'killed' }) => void
    let reentrantRefused = false, reentrantStarted = false
    const id = context.jobs.start({
      kind: 'bash',
      label: 'hold loader slot',
      run: () => {
        try {
          context!.jobs.start({ kind: 'bash', label: 'nested loader job', run: () => {
            reentrantStarted = true
            return { cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }
          } })
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('(limit: 1)')) throw error
          reentrantRefused = true
        }
        return {
          cancel: () => { settle({ status: 'killed' }) },
          done: new Promise((resolve) => { settle = resolve }),
        }
      },
    })
    expect(reentrantRefused).toBe(true)
    expect(reentrantStarted).toBe(false)
    expect(() => context!.jobs.start({
      kind: 'bash',
      label: 'blocked loader job',
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
    })).toThrow('(limit: 1)')
    const registeredJobs = context.jobs.list().length
    context.jobs.kill(id)
    const terminal = await context.jobs.wait(id, 1_000)
    const jobs = context.jobs
    const registryFiber = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-jobs-local')?.fiber
    if (registryFiber === undefined) throw new Error('The loaded jobs provider has no fiber.')
    await registryFiber.dispose()
    let startedAfterUnload = false
    expect(() => jobs.start({ kind: 'bash', label: 'closed registry job', run: () => {
      startedAfterUnload = true
      return { cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }
    } })).toThrow('job registry is closed')
    expect(startedAfterUnload).toBe(false)
    await expect(`${JSON.stringify({ reentrantAdmission: 'rejected', secondAdmission: 'rejected', registeredJobs,
      terminal: terminal.status, closedAdmission: 'rejected' })}\n`)
      .toMatchFileSnapshot(fileURLToPath(new URL('./expected/reentrant-admission.jsonl', import.meta.url)))
  })
})
