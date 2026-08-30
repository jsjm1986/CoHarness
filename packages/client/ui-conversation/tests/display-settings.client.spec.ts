import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConversationSettings } from '../src/submission-settings.ts'
import { ConversationDisplaySettings } from '../src/client/display-settings.ts'

describe('ConversationDisplaySettings', () => {
  it('uses safe defaults and clamps process-local writes', () => {
    const settings = new ConversationDisplaySettings()
    expect(settings.getSnapshot()).toMatchObject({ chatContentWidth: 748, chatFontSize: 14 })

    settings.setWidth(Number.POSITIVE_INFINITY)
    settings.setFontSize(-100)
    expect(settings.getSnapshot()).toMatchObject({ chatContentWidth: 560, chatFontSize: 12 })
  })

  it('keeps optimistic values while a durable write is saving and adopts acceptance', () => {
    const stub = stubSettingsScope<ConversationSettings>()
    const settings = new ConversationDisplaySettings(stub.scope)
    expect(stub.listenerCount()).toBe(1)

    stub.publish({
      status: 'ready',
      writable: true,
      value: { busyEnter: 'queue', chatContentWidth: 700, chatFontSize: 13 },
      write: { status: 'idle' },
    })
    settings.setWidth(840)
    expect(settings.width()).toBe(840)

    stub.publish({ write: { status: 'saving' } })
    expect(settings.width()).toBe(840)
    stub.publish({
      value: { busyEnter: 'queue', chatContentWidth: 840, chatFontSize: 13 },
      write: { status: 'idle' },
    })
    expect(settings.width()).toBe(840)
    expect(stub.set).toHaveBeenCalledWith('chatContentWidth', 840)
  })

  it('drops optimistic values when the host rejects a write', () => {
    const stub = stubSettingsScope<ConversationSettings>()
    const settings = new ConversationDisplaySettings(stub.scope)
    stub.publish({
      status: 'ready',
      writable: true,
      value: { busyEnter: 'queue', chatContentWidth: 700, chatFontSize: 13 },
      write: { status: 'idle' },
    })
    settings.setFontSize(17)
    expect(settings.fontSize()).toBe(17)
    stub.publish({ write: { status: 'error', code: 'conflict', message: 'stale revision' } })
    expect(settings.fontSize()).toBe(13)
  })

  it('unsubscribes once disposed', () => {
    const stub = stubSettingsScope<ConversationSettings>()
    const settings = new ConversationDisplaySettings(stub.scope)
    expect(stub.listenerCount()).toBe(1)
    settings.dispose()
    expect(stub.listenerCount()).toBe(0)
    settings.dispose()
  })
})
