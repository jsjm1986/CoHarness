/** Actual parent, child and grandchild notifications with a one-frame queue. */
import { validatedSessionEvent, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from './auxiliary-model-fixture.ts'

const fixture = new URL('./fixtures/sdk-session-lineage/', import.meta.url)

it('retains real grandchild output independently of notification queue capacity', () =>
  withAuxiliaryModelHarness(fixture, { provider: 'sdk-lineage', model: 'm' }, async (harness, options) => {
    options.maxNotificationQueue = 1
    await harness.start()
    const received: HarnessNotification[] = []
    const drain = (): void => {
      for (let value = tree?.tryNext(); value !== undefined; value = tree?.tryNext()) received.push(value)
    }
    const closed = harness.client.subscribe(() => { closed.close(); return true })
    const sink = harness.client.subscribe(() => { sink.tryNext(); drain(); return true })
    const tree = harness.client.subscribeSessionTree('lineage-root')
    try {
      await harness.client.prompt('lineage-root', [{ type: 'text', text: 'root' }])
      await harness.client.request('session/wait', { sessionId: 'lineage-root' })
      drain()
      const answers = received.flatMap((notification) => {
        if (notification.method !== 'session.event') return []
        const event = validatedSessionEvent(notification.params.event)
        if (event.type !== 'assistant/message') return []
        return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      })
      expect(answers).toEqual(['GRANDCHILD_DONE', 'CHILD_DONE', 'SDK_LINEAGE_DONE'])
      expect(received.filter(notification => notification.method === 'subagent.started')).toHaveLength(2)
      expect(closed.tryNext()).toBeUndefined()
      await expect(closed.next()).rejects.toThrow('notification subscription closed')
    } finally { tree.close(); sink.close(); closed.close() }
  }), 120_000)
