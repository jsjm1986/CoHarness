/** Confirm one-shot job cleanup through the actual SDK profile. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['completed', 'rejected', 'pending-completed', 'pending-rejected'] as const)('retains one-shot cleanup after a %s result', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/subagent-cleanup/', import.meta.url)
  await withAuxiliaryModelHarness(fixture, { provider: 'subagent-cleanup-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Subagent fixture requires its owned environment')
    options.env.DSH_SUBAGENT_CLEANUP = mode
    const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
      reply: string
      completed: unknown
      rejected: unknown
      'pending-completed': unknown
      'pending-rejected': unknown
    }
    await harness.start()
    const result = await harness.run('Check subagent cleanup ownership.', { sessionId: 'subagent-cleanup' })
    const proof: unknown = JSON.parse(await readFile(join(options.cwd, 'subagent-cleanup-proof.json'), 'utf8'))
    expect(proof, JSON.stringify(proof)).toEqual(expected[mode])
    expect(result.finalResponse, JSON.stringify(result)).toBe(expected.reply)
  })
})
