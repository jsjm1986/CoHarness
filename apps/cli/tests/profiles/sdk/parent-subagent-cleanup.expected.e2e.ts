/** SDK shutdown drains a failed original child while the surrounding runtime stays live. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each([
  ['workflow', 'live'], ['workflow', 'retired'], ['ralph', 'live'], ['ralph', 'retired'],
] as const)('joins %s parent cleanup through a %s Core', async (mode, phase) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/parent-subagent-cleanup/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
    reply: string
    cases: Record<string, { before: unknown; after: unknown }>
  }
  await withAuxiliaryModelHarness(fixture, { provider: 'parent-cleanup-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Parent fixture requires its owned environment')
    options.env.DSH_PARENT_CLEANUP = mode
    options.env.DSH_PARENT_CLEANUP_PHASE = phase
    await harness.start()
    expect((await harness.run('Verify owned parent cleanup.', { sessionId: 'parent-cleanup' })).finalResponse).toBe(expected.reply)
    const wanted = expected.cases[`${mode}-${phase}`]
    if (wanted === undefined) throw new Error('Missing parent cleanup expectation')
    expect(JSON.parse(await readFile(join(options.cwd, 'parent-cleanup-before.json'), 'utf8'))).toEqual(wanted.before)
    await harness.client.request('shutdown')
    let proof: unknown
    try { proof = JSON.parse(await readFile(join(options.cwd, 'parent-cleanup-proof.json'), 'utf8')) }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      proof = { cleanupConfirmed: false }
    }
    expect(proof).toEqual(wanted.after)
  })
})
