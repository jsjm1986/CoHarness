/** Real SDK projection of a logged authorization review and its admitted tool. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DeepSeekHarness, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-auto-review'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it('projects exact Auto review input, completed admission and persisted-session continuation', () =>
  withAuxiliaryModelHarness(new URL('../../../../../examples/headless-agent/tests/fixtures/auto-review-model/', import.meta.url), { provider: 'review-fixture', model: 'review-model' }, async (harness, options) => {
    await harness.start()
    const subscription = harness.client.subscribeSessionTree('review-fixture-session')
    const timeout = setTimeout(() => { subscription.close() }, 60_000)
    try {
      const result = await harness.run('Write the owned fixture file.', { sessionId: 'review-fixture-session' })
      const requests: Record<string, unknown>[] = []
      let completion: unknown
      while (completion === undefined) {
        const notification = await subscription.next()
        if (notification.method !== 'session.event') continue
        const event = validatedSessionEvent(notification.params.event)
        const record = pluginRecordOf(event)
        if (record?.type === 'plugin:auto-review-fixture/complete') { completion = record.data; continue }
        if (event.type !== 'auto-review/request') continue
        const request = event.data.request
        const text = request.messages.flatMap(message => message.content)
          .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        requests.push({ type: event.type, callId: event.data.callId,
          provider: request.provider, model: request.model, temperature: request.temperature,
          reasoningEffort: request.reasoningEffort, containsPendingAction: text.includes('PENDING_ACTION'),
        })
      }
      const expected: unknown = JSON.parse(await readFile(new URL('../../../../../examples/headless-agent/tests/fixtures/auto-review-model/expected.json', import.meta.url), 'utf8'))
      expect({ finalResponse: result.finalResponse, requests, completion }).toEqual(expected)
      expect(await readFile(join(options.cwd, 'reviewed.txt'), 'utf8')).toBe('reviewed\n')
    } finally { clearTimeout(timeout); subscription.close() }
    await harness.close()
    const continued = new DeepSeekHarness(options)
    try {
      const session = await continued.resumeSession('review-fixture-session')
      expect((await session.run('Write the owned fixture file again.')).finalResponse).toBe('REVIEW_DONE')
    } finally { await continued.close() }
  }), 120_000)
