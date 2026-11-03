/** Real SDK projection of governed native HTTP and its durable request input. */
import { readFile } from 'node:fs/promises'
import { DeepSeekHarness, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web-search-deepseek'
import type {} from '@deepseek-ai/dsh-web-search-perplexity'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from './auxiliary-model-fixture.ts'

it.each(['native', 'sonar'])('projects admitted %s search and continues its persisted Session in a fresh process', (protocol) => {
  const fixture = new URL(`./fixtures/governed-${protocol}-model/`, import.meta.url)
  return withAuxiliaryModelHarness(fixture, { provider: 'native-fixture', model: 'conversation' }, async (harness, options) => {
    await harness.start()
    const subscription = harness.client.subscribeSessionTree('native-model-session')
    const timeout = setTimeout(() => { subscription.close() }, 60_000)
    try {
      const result = await harness.run('Search the native fixture.', { sessionId: 'native-model-session' })
      expect(result.finalResponse, JSON.stringify(result)).toBe('NATIVE_SEARCH_DONE')
      const requests: unknown[] = []
      let completion: unknown
      while (completion === undefined) {
        const notification = await subscription.next()
        if (notification.method !== 'session.event') continue
        const event = validatedSessionEvent(notification.params.event)
        const record = pluginRecordOf(event)
        if (record?.type === 'plugin:native-model-fixture/complete') { completion = record.data; continue }
        if (event.type === 'web/deepseek-search-llm-request') {
          requests.push({ type: event.type, path: new URL(event.data.endpoint).pathname,
            apiVersion: event.data.apiVersion, model: event.data.body.model, maxTokens: event.data.body.max_tokens,
            query: event.data.body.messages[0].content[0].text,
          })
        } else if (event.type === 'web/perplexity-search-llm-request') {
          requests.push({ type: event.type, path: new URL(event.data.endpoint).pathname,
            model: event.data.body.model, maxTokens: event.data.body.max_tokens, query: event.data.body.messages[0].content,
          })
        }
      }
      const expected: unknown = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8'))
      expect({ finalResponse: result.finalResponse, requests, completion }).toEqual(expected)
    } finally { clearTimeout(timeout); subscription.close() }
    await harness.close()
    const continued = new DeepSeekHarness(options)
    try {
      const session = await continued.resumeSession('native-model-session')
      expect((await session.run('Search the native fixture again.')).finalResponse).toBe('NATIVE_SEARCH_DONE')
    } finally { await continued.close() }
  })
}, 120_000)
