/** Real SDK parent, delegation tool, nested SDK child and process accounting. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from './auxiliary-model-fixture.ts'
import { prepareGovernance } from './fixtures/sdk-process-admission/prepare-governance.mjs'

const fixture = new URL('./fixtures/sdk-process-admission/', import.meta.url)

it.each(['admit', 'refused', 'native', 'native-sonar'])('projects actual SDK child process admission: %s', mode =>
  withAuxiliaryModelHarness(fixture, { provider: 'owned-sdk-parent', model: 'm' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('The owned SDK fixture environment is missing.')
    if (options.dshHome === undefined) throw new Error('The owned SDK fixture home is missing.')
    await prepareGovernance(options.dshHome)
    options.env.DSH_TEST_SDK_PROCESS_MODE = mode
    const result = await harness.run('Delegate one owned task.', { sessionId: 'sdk-process-owner' })
    expect(result.finalResponse, JSON.stringify({ events: result.events.slice(-4),
      diagnostics: await readFile(join(options.cwd, '.sdk-process-diagnostics.log'), 'utf8'),
    })).toBe('SDK_PROCESS_DONE')
    const completion = result.events.map(event => pluginRecordOf(validatedSessionEvent(event)))
      .find(record => record?.type === 'plugin:sdk-process-admission/complete')?.data
    expect(completion).toEqual(JSON.parse(await readFile(new URL(`expected.${mode}.json`, fixture), 'utf8')))
  }), 120_000)
