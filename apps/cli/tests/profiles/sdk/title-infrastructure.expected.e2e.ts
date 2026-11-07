/** Actual SDK title requests retain Runtime admission and independent billing. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
import { prepareGovernance } from '../../../../../examples/headless-agent/tests/fixtures/sdk-process-admission/prepare-governance.mjs'

const cases = ['prepare', 'admission'].flatMap(phase => ['same', 'foreign'].map(caller => ({ phase, caller })))
it.each(cases)('retains Runtime title ownership during $phase with $caller caller', async ({ phase, caller }) => {
  await withAuxiliaryModelHarness(new URL('../../../../../examples/headless-agent/tests/fixtures/title-infrastructure/', import.meta.url),
    { provider: 'runtime-title-fixture', model: 'main-model' }, async (harness, options) => {
      if (options.env === undefined || options.dshHome === undefined) throw new Error('Title fixture requires its owned SDK environment')
      options.env.DSH_TITLE_PHASE = phase; options.env.DSH_TITLE_CALLER = caller
      await prepareGovernance(options.dshHome)
      const ready = join(options.cwd, 'title-pending.json'), observed = join(options.cwd, 'title-observation.json')
      const release = join(options.cwd, 'title-continue')
      let pending: ReturnType<typeof harness.run> | undefined
      let failure: { reason: unknown } | undefined
      try {
        await harness.start()
        pending = harness.run('Own the background Runtime title.', { sessionId: 'title-infrastructure' })
        void pending.catch((reason: unknown) => { failure = { reason } })
        const deadline = AbortSignal.timeout(40_000)
        while (!existsSync(ready) && !existsSync(observed)) {
          if (failure !== undefined) throw failure.reason
          await delay(10, undefined, { signal: deadline })
        }
        if (existsSync(ready)) {
          expect(JSON.parse(await readFile(ready, 'utf8')) as unknown).toEqual({ phase, caller })
          await writeFile(release, 'released')
        }
        expect((await pending).finalResponse).toBe('TITLE_INFRASTRUCTURE_DONE')
        while (!existsSync(observed)) await delay(10, undefined, { signal: deadline })
        const actual: unknown = JSON.parse(await readFile(observed, 'utf8'))
        const expected = JSON.parse(await readFile(new URL('../../../../../examples/headless-agent/tests/fixtures/title-infrastructure/expected.json', import.meta.url), 'utf8')) as Record<string, unknown>
        expect(actual).toEqual(expected[`${phase}/${caller}`])
      } finally { await writeFile(release, 'released'); await pending?.catch(() => {}) }
    })
})
