/** Exact-parent late cleanup joins a waiting admission through the actual SDK profile. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each(['refused', 'recovered'] as const)('rechecks late cleanup while %s', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/queued-subagent-cleanup/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; refused: unknown; recovered: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'queued-cleanup-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Queued fixture requires its owned environment')
    options.env.DSH_QUEUED_CLEANUP = mode
    await harness.start()
    const result = await harness.run('Verify cleanup joining a waiting admission.', { sessionId: 'queued-cleanup' })
    const proof = JSON.parse(await readFile(join(options.cwd, 'queued-cleanup-proof.json'), 'utf8')) as unknown
    expect(result.finalResponse, JSON.stringify(proof)).toBe(expected.reply)
    expect(proof).toEqual(expected[mode])
  })
})
