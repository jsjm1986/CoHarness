/** Actual application resource requests retire rejected origins and unsent cancellations. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['origin-failure', 'cancel-before-registration', 'uncertain-owner', 'response-cancellation'] as const)('retains %s resource ownership', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/resource-retirement/', import.meta.url)
  await withAuxiliaryModelHarness(fixture, { provider: 'resource-retirement-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Resource fixture requires its owned environment')
    options.env.DSH_RESOURCE_RETIREMENT = mode
    const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
      reply: string
      proof: object
      uncertainOwner: { reply: string; proof: unknown }
      responseCancellation: { reply: string; proof: unknown }
    }
    const oracle = mode === 'response-cancellation' ? expected.responseCancellation
      : mode === 'uncertain-owner' ? expected.uncertainOwner : { reply: expected.reply,
        proof: { ...expected.proof, mode, reason: mode === 'origin-failure' ? 'unavailable' : 'cancelled' } }
    await harness.start()
    const result = await harness.run('Check independent resource request ownership.', { sessionId: 'resource-retirement' })
    expect(result.finalResponse).toBe(oracle.reply)
    expect(JSON.parse(await readFile(join(options.cwd, 'resource-retirement-proof.json'), 'utf8')) as unknown)
      .toEqual(oracle.proof)
  })
})
