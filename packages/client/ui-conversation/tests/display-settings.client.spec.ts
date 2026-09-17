import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

  it('persists the fill preference and clears it on an explicit width', () => {
    const stub = stubSettingsScope<ConversationSettings>()
    const settings = new ConversationDisplaySettings(stub.scope)
    stub.publish({
      status: 'ready',
      writable: true,
      value: { busyEnter: 'queue', chatContentWidth: 700, chatFontSize: 13 },
      write: { status: 'idle' },
    })
    settings.setFullWidth(true)
    expect(settings.getSnapshot().chatFullWidth).toBe(true)
    expect(stub.set).toHaveBeenCalledWith('chatFullWidth', true)

    settings.setWidth(900)
    expect(settings.getSnapshot()).toMatchObject({ chatContentWidth: 900, chatFullWidth: false })
    expect(stub.set).toHaveBeenCalledWith('chatFullWidth', false)

    stub.publish({
      value: { busyEnter: 'queue', chatContentWidth: 900, chatFontSize: 13, chatFullWidth: false },
      write: { status: 'idle' },
    })
    expect(settings.getSnapshot().chatFullWidth).toBe(false)
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

describe('display-settings stylesheet contract', () => {
  const root = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)), 'utf8')

  it('re-points the body-size markdown tokens at the chat font-size preference', () => {
    // The shared markdown sheet pins its type through these tokens; without the
    // re-point the preference stops at the .markdown container and transcript
    // text never changes size. The re-point scales around the 16px/28px design
    // baseline (preference 14 ↔ design 16), keeping the 1.75 ratio.
    expect(root).toContain('--dsw-font-markdown-base: calc(16px + var(--dsh-chat-font-size) - 14px)/calc(28px + (var(--dsh-chat-font-size) - 14px) * 1.75) var(--dsw-font-family)')
    expect(root).toContain('--dsw-font-markdown-base-strong: 600 calc(16px + var(--dsh-chat-font-size) - 14px)/calc(28px + (var(--dsh-chat-font-size) - 14px) * 1.75) var(--dsw-font-family)')
    expect(root).toContain('--dsw-font-markdown-h4: 600 calc(16px + var(--dsh-chat-font-size) - 14px)/calc(28px + (var(--dsh-chat-font-size) - 14px) * 1.75) var(--dsw-font-family)')
  })
})
