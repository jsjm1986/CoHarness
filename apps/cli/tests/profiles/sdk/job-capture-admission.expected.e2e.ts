/** SDK background capacity includes callbacks that capture the caller's execution identity before producer startup. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it('keeps native producer startup within the exact-owner limit during authority capture', async () => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/job-capture-admission/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; proof: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'job-capture-fixture', model: 'main-model' }, async (harness, options) => {
    await harness.start()
    const result = await harness.run('Verify job admission before execution capture.', { sessionId: 'job-capture-admission' })
    const proof: unknown = JSON.parse(await readFile(join(options.cwd, 'job-capture-proof.json'), 'utf8'))
    expect(proof, JSON.stringify(proof)).toEqual(expected.proof)
    expect(result.finalResponse).toBe(expected.reply)
  })
})
