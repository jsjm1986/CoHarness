/** Actual Workspace and transport provider remounts through the SDK profile. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['registry', 'transport'] as const)('retains Workspace catalog publication order through %s remount', async (mode) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/workspace-catalog-remount/', import.meta.url)
  await withAuxiliaryModelHarness(fixture, { provider: 'workspace-remount-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Workspace fixture requires its owned environment')
    options.env.DSH_WORKSPACE_REMOUNT = mode
    const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
      reply: string
      registry: unknown
      transport: unknown
    }
    await harness.start()
    const result = await harness.run('Check Workspace catalog replacement.', { sessionId: 'workspace-remount' })
    expect(result.finalResponse, JSON.stringify(result)).toBe(expected.reply)
    expect(JSON.parse(await readFile(join(options.cwd, 'workspace-remount-proof.json'), 'utf8')) as unknown).toEqual(expected[mode])
  })
})
