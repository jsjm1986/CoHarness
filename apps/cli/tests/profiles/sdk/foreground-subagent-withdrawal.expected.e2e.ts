/** Foreground tool collection and cleanup transfer stay inside their runtime withdrawal drain. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each(['completed', 'rejected'] as const)('joins foreground %s collection during runtime withdrawal', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/foreground-subagent-withdrawal/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; completed: unknown; rejected: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'foreground-withdrawal-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Foreground fixture requires its owned environment')
    options.env.DSH_FOREGROUND_WITHDRAWAL = mode
    await harness.start()
    const result = await harness.run('Verify a foreground tool during runtime withdrawal.', { sessionId: 'foreground-withdrawal' })
    const proof = JSON.parse(await readFile(join(options.cwd, 'foreground-withdrawal-proof.json'), 'utf8')) as unknown
    expect(result.finalResponse, JSON.stringify(proof)).toBe(expected.reply)
    expect(proof).toEqual(expected[mode])
  })
})
