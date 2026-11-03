/** Actual Agent creation preserves the SSH target through local-backend denial. */
import { readFile } from 'node:fs/promises'
import { validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from './auxiliary-model-fixture.ts'

const fixture = new URL('./fixtures/sdk-remote-target/', import.meta.url)

it('refuses local SDK execution for a live SSH-bound Agent', () =>
  withAuxiliaryModelHarness(fixture, { provider: 'sdk-remote-guard', model: 'm' }, async (harness) => {
    const result = await harness.run('Check delegation to the selected remote target.', { sessionId: 'sdk-remote-root' })
    expect(result.finalResponse, JSON.stringify(result.events.slice(-4))).toBe('SDK_REMOTE_TARGET_REFUSED')
    const completion = result.events.map(event => pluginRecordOf(validatedSessionEvent(event)))
      .find(record => record?.type === 'plugin:sdk-remote-target/complete')?.data
    expect(completion).toEqual(JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')))
  }), 120_000)
