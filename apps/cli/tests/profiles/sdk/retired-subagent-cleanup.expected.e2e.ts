/** Foreground tool collection and cleanup transfer stay inside their runtime withdrawal drain. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each(['workflow', 'ralph'] as const)('retains %s cleanup through Core replacement', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/retired-subagent-cleanup/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; workflow: unknown; ralph: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'retired-cleanup-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Foreground fixture requires its owned environment')
    options.env.DSH_RETIRED_CLEANUP = mode
    await harness.start()
    const result = await harness.run('Verify original cleanup through runtime replacement.', { sessionId: 'foreground-withdrawal' })
    const proof = JSON.parse(await readFile(join(options.cwd, 'retired-cleanup-proof.json'), 'utf8')) as unknown
    expect(result.finalResponse, JSON.stringify(proof)).toBe(expected.reply)
    expect(proof).toEqual(expected[mode])
  })
})
