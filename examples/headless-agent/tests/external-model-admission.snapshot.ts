/** Real SDK tools refuse external inference before child process admission. */
import { readFile } from 'node:fs/promises'
import { validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from './auxiliary-model-fixture.ts'

const fixture = new URL('./fixtures/external-model-admission/', import.meta.url)

it('reports managed external model refusals through real delegation tools', () =>
  withAuxiliaryModelHarness(fixture, { provider: 'external-control-parent', model: 'm' }, async (harness) => {
    const result = await harness.run('Delegate one task to each external provider.', { sessionId: 'external-control-owner' })
    expect(result.finalResponse).toBe('EXTERNAL_MODELS_REFUSED')
    const completion = result.events.map(event => pluginRecordOf(validatedSessionEvent(event)))
      .find(record => record?.type === 'plugin:external-model-admission/complete')?.data
    expect(completion).toEqual(JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')))
  }), 120_000)
