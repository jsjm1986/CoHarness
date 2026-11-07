/** SDK child control keeps its original collaboration provider across awaits. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
it.each(['personal', 'project'] as const)('refuses %s child input after authority replacement', async (scope) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/subagent-control-authority/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as { reply: string; cases: Record<string, unknown> }
  await withAuxiliaryModelHarness(fixture, { provider: 'authority-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Authority fixture requires its owned environment')
    options.env.DSH_CONTROL_SCOPE = scope
    await harness.start()
    const result = await harness.run('Verify retained child control authority.', { sessionId: 'control-authority' })
    const proof: unknown = JSON.parse(await readFile(join(options.cwd, 'control-authority-proof.json'), 'utf8'))
    expect(proof, JSON.stringify(proof)).toEqual(expected.cases[scope])
    expect(result.finalResponse).toBe(expected.reply)
  })
})
