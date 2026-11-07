/** Actual SDK shutdown transcripts retain ownership of detached speech work. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['duplicate', 'registry'])(
  'joins speech work during %s disposal', async (phase) => {
    const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/speech-removal/', import.meta.url)
    await withAuxiliaryModelHarness(fixture, { provider: 'speech-removal-fixture', model: 'main-model' }, async (harness, options) => {
      if (options.env === undefined) throw new Error('Speech removal fixture requires its owned environment')
      options.env.DSH_SPEECH_REMOVAL_PHASE = phase
      const expected: unknown = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8'))
      await harness.start()
      const result = await harness.run('Join accepted recognition work.', { sessionId: 'speech-removal' })
      expect(result.finalResponse).not.toBe('')
      expect(JSON.parse(result.finalResponse) as unknown).toEqual(expected)
    })
  },
)
