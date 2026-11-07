/** Native transport cleanup and durable workflow endings through the SDK profile. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['workflow', 'ralph'] as const)('recovers foreground %s without losing cleanup ownership', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/workflow-foreground-recovery/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
    reply: string
    workflow: unknown
    ralph: unknown
  }
  await withAuxiliaryModelHarness(fixture, { provider: 'foreground-workflow-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Foreground workflow fixture requires its owned environment')
    options.env.DSH_FOREGROUND_WORKFLOW = mode
    await harness.start()
    const result = await harness.run('Verify foreground workflow cleanup recovery.', { sessionId: 'foreground-workflow' })
    const proof = JSON.parse(await readFile(join(options.cwd, 'foreground-workflow-proof.json'), 'utf8')) as unknown
    expect(result.finalResponse, JSON.stringify(proof)).toBe(expected.reply)
    expect(proof).toEqual(expected[mode])
  })
})
