/** Ordinary provider authorization through the shipped SDK profile and Agent loop. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from './auxiliary-model-fixture.ts'

it.each([
  { name: 'deepseek', directory: 'ordinary-model-revocation', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  { name: 'pi', directory: 'ordinary-pi-revocation', provider: 'ordinary-pi', model: 'm' },
])('projects ordinary $name credential-time revocation without inference or retained permits', ({ directory, provider, model }) => {
  const fixture = new URL(`./fixtures/${directory}/`, import.meta.url)
  return withAuxiliaryModelHarness(fixture, { provider, model }, async (harness, options) => {
    const result = await harness.run('Run an authorized request.', { sessionId: 'ordinary-revocation-owner' })
    const proof: unknown = JSON.parse(await readFile(join(options.cwd, 'ordinary-model-proof.json'), 'utf8'))
    const expected: unknown = JSON.parse(await readFile(new URL('./fixtures/ordinary-model-revocation/expected.json', import.meta.url), 'utf8'))
    expect({ finalResponse: result.finalResponse, proof }).toEqual(expected)
    expect(result.events.some(event => event.type === 'turn/end')).toBe(true)
  })
}, 120_000)
