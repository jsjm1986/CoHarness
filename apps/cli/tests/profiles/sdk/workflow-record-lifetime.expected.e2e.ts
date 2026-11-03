/** Workflow records keep their parent scope after the tool definition withdraws. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each(['foreground', 'background'] as const)('keeps %s workflow records after tool withdrawal', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/workflow-record-lifetime/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; foreground: unknown; background: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'workflow-record-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Workflow record fixture requires its owned environment')
    options.env.DSH_WORKFLOW_RECORD_LIFETIME = mode
    await harness.start()
    const result = await harness.run('Verify workflow records after tool withdrawal.', { sessionId: 'workflow-record' })
    const proof = JSON.parse(await readFile(join(options.cwd, 'workflow-record-proof.json'), 'utf8')) as unknown
    expect(result.finalResponse, JSON.stringify(proof)).toBe(expected.reply)
    expect(proof).toEqual(expected[mode])
  })
})
