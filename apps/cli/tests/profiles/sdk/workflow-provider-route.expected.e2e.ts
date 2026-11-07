/** Real PTC and Ralph runs retain the provider selected before replacement. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['before-first', 'ralph-round'] as const)('retains workflow provider identity at %s', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/workflow-provider-route/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
    seedReply: string
    reply: string
    guardMessage: string
    'before-first': unknown
    'ralph-round': unknown
  }
  await withAuxiliaryModelHarness(fixture, { provider: 'workflow-route-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Workflow route fixture requires its owned environment')
    options.env.DSH_WORKFLOW_ROUTE = mode
    await harness.start()
    const seed = await harness.run('WORKFLOW_PRIVATE_SEED', { sessionId: 'workflow-route' })
    expect(seed.finalResponse).toBe(expected.seedReply)
    const result = await harness.run('Verify independent workflow children.', { sessionId: 'workflow-route' })
    const proof = JSON.parse(await readFile(join(options.cwd, 'workflow-provider-proof.json'), 'utf8')) as unknown
    const diagnostic = await readFile(join(options.cwd, 'workflow-provider-diagnostic.txt'), 'utf8')
    expect(result.finalResponse, JSON.stringify({ proof, diagnostic })).toBe(expected.reply)
    expect(diagnostic).toContain(expected.guardMessage)
    expect(proof).toEqual(expected[mode])
  })
})
