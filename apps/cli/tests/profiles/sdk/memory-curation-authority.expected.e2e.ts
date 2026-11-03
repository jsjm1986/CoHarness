/** Shipped SDK project curation rechecks qualification and issuer after queued grants and tool reads. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

const cases = ['extraction', 'consolidation'].flatMap(kind => ['revocation', 'replacement']
  .flatMap(change => ['grant', 'tool-read', 'cursor'].map(phase => ({ kind, change, phase }))))

it.each(cases)('retains $kind project authority after $change during $phase', async ({ kind, change, phase }) => {
  await withAuxiliaryModelHarness(new URL('../../../../../examples/headless-agent/tests/fixtures/memory-curation-authority/', import.meta.url),
    { provider: 'memory-curation-authority', model: 'memory-curation-authority' }, async (harness, options) => {
      if (options.env === undefined) throw new Error('Auxiliary fixture requires its isolated runtime environment')
      options.env.DSH_MEMORY_AUTHORITY_KIND = kind
      options.env.DSH_MEMORY_AUTHORITY_CHANGE = change
      options.env.DSH_MEMORY_AUTHORITY_PHASE = phase
      const release = join(options.cwd, 'authority-continue')
      try {
        await harness.start()
        expect((await harness.run('Remember our durable project release policy.')).finalResponse).toBe('AUTHORITY_PRIMARY_DONE')
        const deadline = AbortSignal.timeout(30_000)
        const pending = join(options.cwd, 'authority-pending.json')
        while (!existsSync(pending)) await delay(10, undefined, { signal: deadline })
        expect(JSON.parse(await readFile(pending, 'utf8')) as unknown).toEqual({ kind, change, phase, executeAllowed: true })
        await writeFile(release, 'released')
        const observation = join(options.cwd, 'authority-observation.json')
        while (!existsSync(observation)) await delay(10, undefined, { signal: deadline })
        expect(JSON.parse(await readFile(observation, 'utf8')) as unknown).toEqual({
          kind, change, phase, admitted: 2, released: 2, memoryRequests: phase === 'grant' ? 0 : 1,
          replacementAuthorizations: 0, cursorAdvanced: false, ownerContent: 'PRIVATE_PROJECT_MEMORY', loggedBeforeDispatch: true,
        })
      } finally { await writeFile(release, 'released') }
    })
}, 120_000)
