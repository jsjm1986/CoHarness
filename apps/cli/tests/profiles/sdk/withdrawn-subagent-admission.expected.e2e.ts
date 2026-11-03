/** Runtime withdrawal stops admission, joins startup rollback and preserves published holder control. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each(['withdrawn', 'publishing', 'rollback-retry', 'holder'] as const)('owns startup during runtime withdrawal: %s', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/withdrawn-subagent-admission/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; withdrawn: unknown; publishing: unknown; 'rollback-retry': unknown; holder: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'withdrawn-admission-cleanup-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Withdrawal fixture requires its owned environment')
    options.env.DSH_WITHDRAWAL_ADMISSION = mode
    await harness.start()
    const result = await harness.run('Verify startup ownership during runtime withdrawal.', { sessionId: 'withdrawal-admission' })
    const proof = JSON.parse(await readFile(join(options.cwd, 'withdrawal-admission-proof.json'), 'utf8')) as unknown
    expect(result.finalResponse, JSON.stringify(proof)).toBe(expected.reply)
    expect(proof).toEqual(expected[mode])
  })
})
