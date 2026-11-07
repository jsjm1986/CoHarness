/** Keyless replay of driver-free desktop availability through the shipped SDK profile and real Agent loop. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it('logs desktop environment guidance without registering a driver or granting authority', async () => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/desktop-environment/', import.meta.url)
  await withAuxiliaryModelHarness(fixture,
    { provider: 'desktop-environment-fixture', model: 'desktop-environment-model' }, async (harness, options) => {
      await harness.start()
      const result = await harness.run('Explain whether local desktop control is available.', { sessionId: 'desktop-environment' })
      expect(result.finalResponse).toBe('DESKTOP_ENVIRONMENT_EXPLAINED')
      const actual = JSON.parse(await readFile(join(options.cwd, 'desktop-environment-observation.json'), 'utf8')) as { reason: string }
      expect(['headless', 'disabled']).toContain(actual.reason)
      const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as Record<string, unknown>
      expect(actual).toEqual(expected[actual.reason])
    })
})
