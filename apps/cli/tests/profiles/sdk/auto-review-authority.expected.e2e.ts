/** Shipped SDK reviews retain their issuing authority through capacity and physical model dispatch. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

const cases = ['directory', 'grant', 'physical', 'response'].flatMap(phase => ['revoke', 'replace'].map(change => ({ phase, change })))
cases.push({ phase: 'none', change: 'none' })
cases.push({ phase: 'adoption', change: 'adopt' })

it.each(cases)('retains the Auto issuer after $change during $phase', async ({ phase, change }) => {
  await withAuxiliaryModelHarness(new URL('../../../../../examples/headless-agent/tests/fixtures/auto-review-authority/', import.meta.url),
    { provider: 'auto-authority', model: 'auto-authority' }, async (harness, options) => {
      if (options.env === undefined) throw new Error('Auto fixture requires an isolated runtime environment')
      options.env.DSH_AUTO_AUTHORITY_PHASE = phase
      options.env.DSH_AUTO_AUTHORITY_CHANGE = change
      const release = join(options.cwd, 'review-continue')
      let pending: ReturnType<typeof harness.run> | undefined
      try {
        await harness.start()
        pending = harness.run('Write the owned fixture file.')
        if (phase !== 'none') {
          const waiting = join(options.cwd, 'review-pending.json'), deadline = AbortSignal.timeout(30_000)
          while (!existsSync(waiting)) await delay(10, undefined, { signal: deadline })
          expect(JSON.parse(await readFile(waiting, 'utf8')) as unknown).toEqual({ phase, change })
          await writeFile(release, 'released')
        }
        expect((await pending).finalResponse).toBe('AUTO_AUTHORITY_DONE')
        const observed: unknown = JSON.parse(await readFile(join(options.cwd, 'review-observation.json'), 'utf8'))
        const expected = JSON.parse(await readFile(new URL('../../../../../examples/headless-agent/tests/fixtures/auto-review-authority/expected.json', import.meta.url), 'utf8')) as Record<string, unknown>
        expect(observed).toEqual(expected[`${phase}/${change}`])
        const allowed = phase === 'none'
        if (allowed) expect(await readFile(join(options.cwd, 'reviewed.txt'), 'utf8')).toBe('reviewed\n')
        else expect(existsSync(join(options.cwd, 'reviewed.txt'))).toBe(false)
      } finally { await writeFile(release, 'released'); await pending?.catch(() => {}) }
    })
})
