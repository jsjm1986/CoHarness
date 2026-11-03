/** A Loader-composed Agent factory owns different services from the SDK provider. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from './auxiliary-model-fixture.ts'

const fixture = new URL('./fixtures/scoped-sdk-model-admission/', import.meta.url)

it.each(['admit', 'model-denied', 'process-denied'])('retains the SDK initiating Agent services: %s', mode =>
  withAuxiliaryModelHarness(fixture, { provider: 'owned-sdk-parent', model: 'm' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('The scoped SDK fixture environment is missing.')
    options.env.DSH_TEST_SDK_SCOPE_MODE = mode
    const result = await harness.run('Delegate one owned task.', { sessionId: 'sdk-scope-owner' })
    expect(result.finalResponse, JSON.stringify({ events: result.events.slice(-4),
      diagnostics: await readFile(join(options.cwd, '.sdk-process-diagnostics.log'), 'utf8'),
    })).toBe('SDK_PROCESS_DONE')
    const completion = result.events.map(event => pluginRecordOf(validatedSessionEvent(event)))
      .find(record => record?.type === 'plugin:sdk-process-admission/complete')?.data
    expect(completion).toEqual(JSON.parse(await readFile(new URL(`expected.${mode}.json`, fixture), 'utf8')))
  }), 120_000)
