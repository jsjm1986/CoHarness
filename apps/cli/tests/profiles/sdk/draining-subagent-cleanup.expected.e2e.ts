/** Runtime withdrawal joins transferred cleanup and retains parent occupation through the SDK profile. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each(['withdrawal', 'replacement'] as const)('joins cleanup during runtime %s', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/draining-subagent-cleanup/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; withdrawal: unknown; replacement: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'draining-cleanup-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Draining fixture requires its owned environment')
    options.env.DSH_DRAINING_CLEANUP = mode
    await harness.start()
    const result = await harness.run('Verify cleanup during runtime withdrawal.', { sessionId: 'draining-cleanup' })
    const proof = JSON.parse(await readFile(join(options.cwd, 'draining-cleanup-proof.json'), 'utf8')) as unknown
    expect(result.finalResponse, JSON.stringify(proof)).toBe(expected.reply)
    expect(proof).toEqual(expected[mode])
  })
})
