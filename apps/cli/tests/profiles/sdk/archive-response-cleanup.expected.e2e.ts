/** Native HTTP cleanup and retry through the shipped SDK composition. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it('releases refused archive transport and synchronizes a later durable archive', async () => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/archive-response-cleanup/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; proof: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'archive-cleanup-fixture', model: 'main-model' }, async (harness, options) => {
    await harness.start()
    const result = await harness.run('Verify archive response cleanup.', { sessionId: 'archive-response-cleanup' })
    expect(result.finalResponse, JSON.stringify(result)).toBe(expected.reply)
    expect(JSON.parse(await readFile(join(options.cwd, 'archive-response-proof.json'), 'utf8')) as unknown).toEqual(expected.proof)
  })
})
