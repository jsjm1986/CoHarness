/** Actual SDK translations recheck native owners after admission and credential waits. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
import { prepareGovernance } from '../../../../../examples/headless-agent/tests/fixtures/sdk-process-admission/prepare-governance.mjs'

it.each(['allow', 'models', 'key', 'credentials', 'settings-models', 'settings-key', 'settings-initial'])(
  'retains translation ownership during %s', async (phase) => {
    const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/translation-admission/', import.meta.url)
    await withAuxiliaryModelHarness(fixture, { provider: 'translation-fixture', model: 'main-model' }, async (harness, options) => {
      if (options.env === undefined || options.dshHome === undefined) throw new Error('Translation fixture requires its owned environment')
      options.env.DSH_TRANSLATION_PHASE = phase
      await prepareGovernance(options.dshHome)
      const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as Record<string, { reply: string; proof: unknown }>
      const accepted = phase === 'allow' || phase === 'settings-initial'
      await harness.start()
      const result = await harness.run('Keep the original private conversation.', { sessionId: 'translation-admission' })
      expect(result.finalResponse).toBe(expected[accepted ? 'allow' : 'refused']!.reply)
      const proof: unknown = JSON.parse(await readFile(join(options.cwd, 'translation-proof.json'), 'utf8'))
      expect(proof).toEqual(expected[accepted ? 'allow' : 'refused']!.proof)
    })
  },
)
