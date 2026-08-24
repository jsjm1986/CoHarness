/**
 * Compact conversation chrome stylesheet contract, asserted against the CSS text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)), 'utf8')
const hero = readFileSync(fileURLToPath(new URL('../src/client/skeleton/HeroShell.module.css', import.meta.url)), 'utf8')
const input = readFileSync(fileURLToPath(new URL('../src/client/skeleton/InputBar.module.css', import.meta.url)), 'utf8')

describe('conversation compact chrome', () => {
  it('wraps the hero workspace row and tightens header tabs on compact', () => {
    expect(root).toContain("[data-viewport='compact']")
    expect(root).toContain('.heroWorkspaceRow')
    expect(root).toContain('flex-wrap: wrap')
    expect(root).toContain('overflow-x: auto')
    expect(root).toContain('.crumb')
    expect(root).toContain('max-width: 100%')
  })

  it('shrinks the hero headline and grows the workspace chip on compact', () => {
    expect(hero).toContain("[data-viewport='compact']")
    expect(hero).toContain('overflow-wrap: anywhere')
    expect(hero).toContain('min-height: var(--dsw-touch-target)')
  })

  it('gives attach and send the touch target on compact viewports', () => {
    expect(input).toContain("[data-viewport='compact']")
    expect(input).toContain('.add')
    expect(input).toContain('.primary')
    expect(input).toContain('.documentRail')
    expect(input).toContain('.documentStatus')
    expect(input).toContain('var(--dsw-touch-target)')
    expect(input).toContain('flex-wrap: wrap')
    expect(input).toContain('[data-viewport-short]')
  })

  it('keeps stats on one compact line, wraps summaries, and grows jump-to-bottom', () => {
    const stats = readFileSync(fileURLToPath(new URL('../src/client/chat/StatsLine.module.css', import.meta.url)), 'utf8')
    const chat = readFileSync(fileURLToPath(new URL('../src/client/chat/ChatView.module.css', import.meta.url)), 'utf8')
    const reasoning = readFileSync(fileURLToPath(new URL('../src/client/chat/ReasoningRow.module.css', import.meta.url)), 'utf8')
    const injection = readFileSync(fileURLToPath(new URL('../src/client/chat/ContextInjectionRow.module.css', import.meta.url)), 'utf8')
    const command = readFileSync(fileURLToPath(new URL('../src/client/chat/GenericCommandCard.module.css', import.meta.url)), 'utf8')
    const contextMeter = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ContextMeter.module.css', import.meta.url)), 'utf8')
    expect(stats).toContain("[data-viewport='compact']")
    expect(stats).toContain('max-height: 20px')
    expect(stats).toContain('text-overflow: ellipsis')
    expect(chat).toContain('.toBottom')
    expect(chat).toContain('var(--dsw-touch-target)')
    expect(reasoning).toContain('white-space: normal')
    expect(injection).toContain('white-space: normal')
    expect(command).toContain('white-space: normal')
    expect(contextMeter).toContain('var(--dsw-mobile-sheet-max-height)')
    expect(contextMeter).toContain('var(--dsw-mobile-sheet-radius)')
    const actions = readFileSync(fileURLToPath(new URL('../src/client/chat/MessageIconActions.module.css', import.meta.url)), 'utf8')
    expect(actions).toContain('flex-wrap: wrap')
    expect(actions).toContain('min-width: var(--dsw-touch-target)')
  })

  it('raises a trajectory details takeover above the absolute composer seat', () => {
    expect(root).toContain('[data-trajectory-details]')
    expect(root).toContain('z-index: 8')
    expect(root).toContain("[data-slot='conversation.session']")
  })

  it('keeps the session settings surface light and compact', () => {
    const sheet = readFileSync(fileURLToPath(new URL('../src/client/skeleton/SessionSettingsSheet.module.css', import.meta.url)), 'utf8')
    const permission = readFileSync(fileURLToPath(new URL('../src/client/skeleton/PermissionSelect.module.css', import.meta.url)), 'utf8')
    expect(sheet).toContain('max-height: min(64dvh')
    expect(sheet).toContain('min-height: 40px')
    expect(sheet).toContain('--dsw-mobile-option-row-height: 44px')
    expect(sheet).toContain('background: var(--dsw-alias-interactive-bg-active)')
    expect(permission).toContain('gap: 2px')
    expect(permission).toContain('padding: 0 8px')
  })
})
