/** Live file settings cancel real SDK auxiliary requests before the runtime begins shutdown. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

const cases = ['recall', 'extraction', 'consolidation'].flatMap(kind => ['commit', 'remount', 'detach'].map(change => ({ kind, change })))

it.each(cases)('cancels $kind after settings $change while retaining provider cleanup', async ({ kind, change }) => {
  await withAuxiliaryModelHarness(new URL('../../../../../examples/headless-agent/tests/fixtures/memory-curation-settings/', import.meta.url),
    { provider: 'memory-curation-settings', model: 'memory-curation-settings' }, async (harness, options) => {
      if (options.env === undefined) throw new Error('Auxiliary fixture requires its isolated runtime environment')
      options.env.DSH_CURATION_FIXTURE_KIND = kind
      options.env.DSH_CURATION_FIXTURE_CHANGE = change
      const marker = join(options.cwd, 'curation-observation.json')
      try {
        if (change === 'detach') await writeFile(join(options.cwd, 'memory-settings.json'), JSON.stringify({ memory: { [kind]: true } }))
        await harness.start()
        expect((await harness.run('Remember our durable release policy.')).finalResponse).toBe('MEMORY_DONE')
        const deadline = AbortSignal.timeout(30_000)
        while (!existsSync(marker)) await delay(10, undefined, { signal: deadline })
        const observation: unknown = JSON.parse(await readFile(marker, 'utf8'))
        expect(observation).toEqual({ kind, change, memoryRequests: 1, cancelledBeforeShutdown: true,
          ownerContent: 'PRIVATE_CURATOR_BODY', loggedBeforeDispatch: true, livePermits: kind === 'recall' ? 2 : 1 })
        await writeFile(join(options.cwd, 'curation-release'), 'released')
        const quiescent = join(options.cwd, 'curation-quiescent.json')
        while (!existsSync(quiescent)) await delay(10, undefined, { signal: deadline })
        expect(JSON.parse(await readFile(quiescent, 'utf8')) as unknown).toEqual({ admitted: 2, released: 2, providerFinished: true })
      } finally { await writeFile(join(options.cwd, 'curation-release'), 'released') }
    })
}, 120_000)
