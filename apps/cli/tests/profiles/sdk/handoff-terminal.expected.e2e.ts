/** Session handoff returns complete extraction or its authorized local history. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['error', 'aborted', 'max-tokens', 'tool-calls', 'missing', 'stop', 'literal'])(
  'selects the handoff briefing after model finish %s', async (reason) => {
    const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/handoff-terminal/', import.meta.url)
    await withAuxiliaryModelHarness(fixture, { provider: 'handoff-fixture', model: 'handoff-model' }, async (harness, options) => {
      if (options.env === undefined) throw new Error('Handoff fixture requires its owned environment')
      options.env.DSH_HANDOFF_FINISH = reason
      const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as Record<string, string>
      await harness.start()
      const task = reason === 'literal' ? "KEEP_LOCAL_HISTORY $$ $& $` $'" : 'KEEP_LOCAL_HISTORY'
      const result = await harness.run(task, { sessionId: 'handoff-terminal' })
      const proof: unknown = JSON.parse(await readFile(join(options.cwd, 'handoff-request-proof.json'), 'utf8'))
      expect(proof).toEqual(JSON.parse(await readFile(new URL('request.expected.json', fixture), 'utf8')) as unknown)
      expect(result.finalResponse).toBe(expected[reason])
    })
  },
)
