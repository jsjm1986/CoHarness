/** Real foreground Consumer cleanup gates and provider replacement through the SDK profile. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['published', 'catalog', 'replacement'] as const)('rechecks cleanup and provider admission after %s', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/subagent-retry-admission/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
    reply: string
    published: unknown
    catalog: unknown
    replacement: unknown
  }
  await withAuxiliaryModelHarness(fixture, { provider: 'subagent-retry-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Subagent retry fixture requires its owned environment')
    options.env.DSH_SUBAGENT_RETRY = mode
    await harness.start()
    const result = await harness.run('Verify subagent cleanup admission.', { sessionId: 'subagent-retry' })
    expect(result.finalResponse, JSON.stringify(result)).toBe(expected.reply)
    expect(JSON.parse(await readFile(join(options.cwd, 'subagent-retry-proof.json'), 'utf8')) as unknown).toEqual(expected[mode])
  })
})
