/** SDK model preflight keeps cancellation and quiescence with its original Core. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each(['foreground', 'background'] as const)('joins %s model preflight through Runtime withdrawal', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/subagent-model-preflight/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; cases: Record<string, unknown> }
  await withAuxiliaryModelHarness(fixture, { provider: 'preflight-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Preflight fixture requires its owned environment')
    options.env.DSH_PREFLIGHT_MODE = mode
    await harness.start()
    const result = await harness.run('Verify original child model preflight.', { sessionId: 'subagent-preflight' })
    const proof: unknown = JSON.parse(await readFile(join(options.cwd, 'preflight-proof.json'), 'utf8'))
    expect(proof, JSON.stringify(proof)).toEqual(expected.cases[mode])
    expect(result.finalResponse).toBe(expected.reply)
  })
})
