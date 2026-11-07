/** Workflow and job cleanup through the real SDK profile and Node PTC process. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['holder-retry', 'background-retry'] as const)('retains workflow cleanup for %s', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/workflow-cleanup/', import.meta.url)
  await withAuxiliaryModelHarness(fixture, { provider: 'workflow-cleanup-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Workflow fixture requires its owned environment')
    options.env.DSH_WORKFLOW_CLEANUP = mode
    const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
      reply: string
      'holder-retry': unknown
      'background-retry': unknown
    }
    await harness.start()
    const result = await harness.run('Check workflow cleanup ownership.', { sessionId: 'workflow-cleanup' })
    expect(result.finalResponse, JSON.stringify(result)).toBe(expected.reply)
    expect(JSON.parse(await readFile(join(options.cwd, 'workflow-cleanup-proof.json'), 'utf8')) as unknown).toEqual(expected[mode])
  })
})
