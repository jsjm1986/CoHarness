/** Actual SDK automatic compaction retains execution authority and billing through model dispatch. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
import { prepareGovernance } from '../../../../../examples/headless-agent/tests/fixtures/sdk-process-admission/prepare-governance.mjs'

const cases = ['preparation', 'grant', 'authorization', 'physical'].flatMap(phase => ['same', 'different'].map(change => ({ phase, change })))
cases.push({ phase: 'grant', change: 'inputs' }, { phase: 'grant', change: 'primary' }, { phase: 'none', change: 'none' })

it.each(cases)('retains compaction billing after $change during $phase', async ({ phase, change }) => {
  await withAuxiliaryModelHarness(new URL('../../../../../examples/headless-agent/tests/fixtures/governance-execution/', import.meta.url),
    { provider: 'governance-fixture', model: 'governance-model' }, async (harness, options) => {
      if (options.env === undefined) throw new Error('Governance fixture requires an isolated runtime environment')
      options.env.DSH_GOVERNANCE_PHASE = phase
      options.env.DSH_GOVERNANCE_CHANGE = change
      const release = join(options.cwd, 'governance-continue')
      let pending: ReturnType<typeof harness.run> | undefined
      try {
        if (options.dshHome === undefined) throw new Error('Governance fixture requires its owned Harness home')
        await prepareGovernance(options.dshHome)
        await harness.start()
        const seed = await harness.run('Preserve this project policy. '.repeat(1800), { sessionId: 'governance-execution' })
        expect(seed.finalResponse).toBe('GOVERNANCE_SEED_DONE')
        pending = harness.run('Continue the owned task.', { sessionId: 'governance-execution' })
        if (phase !== 'none') {
          const waiting = join(options.cwd, 'governance-pending.json'), deadline = AbortSignal.timeout(30_000)
          while (!existsSync(waiting)) await delay(10, undefined, { signal: deadline })
          expect(JSON.parse(await readFile(waiting, 'utf8')) as unknown).toEqual({ phase, change })
          await writeFile(release, 'released')
        }
        expect((await pending).finalResponse).toBe('GOVERNANCE_NEXT_DONE')
        const observed: unknown = JSON.parse(await readFile(join(options.cwd, 'governance-observation.json'), 'utf8'))
        const expected = JSON.parse(await readFile(new URL('../../../../../examples/headless-agent/tests/fixtures/governance-execution/expected.json', import.meta.url), 'utf8')) as Record<string, unknown>
        expect(observed).toEqual(expected[`${phase}/${change}`])
      } finally { await writeFile(release, 'released'); await pending?.catch(() => {}) }
    })
})
