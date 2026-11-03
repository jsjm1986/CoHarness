/** Real TypeScript SDK projection of individually admitted memory model requests. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { DeepSeekHarness, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { withAuxiliaryModelHarness } from '../../examples/headless-agent/tests/auxiliary-model-fixture.ts'
import type {} from '@deepseek-ai/dsh-memory-context'
import type {} from '@deepseek-ai/dsh-memory-curation'

it('projects recall, extraction and consolidation after exact logging and permit quiescence', () =>
  withAuxiliaryModelHarness(new URL('./memory-auxiliary/', import.meta.url), { provider: 'memory-fixture', model: 'memory-model' }, async (harness, options) => {
    await harness.start()
    const subscription = harness.client.subscribeSessionTree('memory-fixture-session')
    const timeout = setTimeout(() => { subscription.close() }, 60_000)
    try {
      const result = await harness.run('Remember the Friday release freeze.', { sessionId: 'memory-fixture-session' })
      const requests: Record<string, unknown>[] = []
      let completion: unknown
      while (completion === undefined) {
        const notification = await subscription.next()
        if (notification.method !== 'session.event') continue
        const event = validatedSessionEvent(notification.params.event)
        if (event.type === 'plugin:memory-fixture/complete') { completion = event.data; continue }
        if (event.type !== 'memory/recall-request' && event.type !== 'memory/curation-request') continue
        const request = event.data.request
        const text = request.messages.flatMap(message => message.content)
          .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        requests.push({ type: event.type,
          ...event.type === 'memory/curation-request' ? { kind: event.data.kind, round: event.data.round } : {},
          provider: request.provider, model: request.model, maxTokens: request.maxTokens,
          reasoningEffort: request.reasoningEffort, containsSeedMemory: text.includes('release-freeze'),
        })
      }
      const expected: unknown = JSON.parse(await readFile(new URL('./memory-auxiliary/expected.json', import.meta.url), 'utf8'))
      expect({ finalResponse: result.finalResponse, requests, completion }).toEqual(expected)
    } finally { clearTimeout(timeout); subscription.close() }
    await harness.close()
    const continued = new DeepSeekHarness(options)
    try {
      const session = await continued.resumeSession('memory-fixture-session')
      expect((await session.run('Remember the Friday release freeze.')).finalResponse).toBe('MEMORY_DONE')
    } finally { await continued.close() }
  }), 120_000)
