/** SDK application preserves exact command ownership through durable lifecycle callbacks. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it('refuses withdrawn command handlers and logs paired failures before accepting a fresh command', async () => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/command-registration/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; proof: unknown }
  await withAuxiliaryModelHarness(fixture, { provider: 'command-registration-fixture', model: 'main-model' }, async (harness, options) => {
    await harness.start()
    const result = await harness.run('Verify command registration ownership.', { sessionId: 'command-registration' })
    const proof: unknown = JSON.parse(await readFile(join(options.cwd, 'command-registration-proof.json'), 'utf8'))
    expect(proof, JSON.stringify(proof)).toEqual(expected.proof)
    expect(result.finalResponse).toBe(expected.reply)
  })
})
