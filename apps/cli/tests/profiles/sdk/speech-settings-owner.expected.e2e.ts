/** Actual SDK application transcripts use the currently bound speech settings provider. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['withdrawn', 'replaced', 'write', 'persist-withdrawn'])(
  'binds speech preferences after Settings is %s', async (phase) => {
    const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/speech-settings-owner/', import.meta.url)
    await withAuxiliaryModelHarness(fixture, { provider: 'speech-settings-fixture', model: 'main-model' }, async (harness, options) => {
      if (options.env === undefined) throw new Error('Speech fixture requires its owned environment')
      options.env.DSH_SPEECH_SETTINGS_PHASE = phase
      const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as Record<string, unknown>
      await harness.start()
      const result = await harness.run('Use the current speech preferences.', { sessionId: 'speech-settings-owner' })
      expect(result.finalResponse).not.toBe('')
      expect(JSON.parse(result.finalResponse) as unknown).toEqual(expected[phase])
    })
  },
)
