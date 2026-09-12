// @vitest-environment jsdom
/** Session statistics pills: token/cache totals and time details stay visible in the composer dock. */
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { conversationSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { StatsPills, type StatsPillsProps } from '../src/client/chat/StatsPills.tsx'
import { en } from '../src/client/locales.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => { document.body.innerHTML = '' })

const SID = 'stats-pills-session' as SessionId
const t = makeTranslate(en, commonEn)

function snapshot(nodes: ConversationSnapshot['nodes'] = []): ConversationSnapshot {
  const base = conversationSnapshot(SID)
  return { ...base, nodes, chat: chatSnapshotFixture({ nodes }) }
}

function renderPills(
  values: Record<string, unknown>,
  nodes: ConversationSnapshot['nodes'] = [],
) {
  const current = snapshot(nodes)
  const useSession: StatsPillsProps['useSession'] = selector => selector(current)
  const useProjection = ((key: string) => values[key]) as StatsPillsProps['useProjection']
  return render(<StatsPills useSession={useSession} useProjection={useProjection} t={t} />)
}

describe('StatsPills', () => {
  it('shows token total and cache-hit share, then exposes exact buckets', () => {
    const view = renderPills({
      tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 },
      sessionStats: { turns: 1, steps: 1, llmMs: 1_200, toolMs: 0, ttftMs: 200, ttftSteps: 1, decodeMs: 800, decodeTokens: 20 },
    })

    expect(view.getByRole('button', { name: '1K tok · Cache hit 90%' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '1K tok · Cache hit 90%' }))
    const dialog = view.getByRole('dialog', { name: 'Token usage' })
    expect(dialog.textContent).toContain('Cache hit90%')
    expect(dialog.textContent).toContain('Uncached input100 tok')
    expect(dialog.textContent).toContain('Cached input900 tok')
    expect(dialog.textContent).toContain('Output20 tok')
  })

  it('shows time and throughput in a separate dialog', () => {
    const view = renderPills({
      sessionStats: { turns: 2, steps: 3, llmMs: 61_000, toolMs: 3_000, ttftMs: 400, ttftSteps: 2, decodeMs: 2_000, decodeTokens: 80 },
    })

    const trigger = view.getByRole('button', { name: '2 turns · 3 steps · 40 tok/s' })
    fireEvent.click(trigger)
    const dialog = view.getByRole('dialog', { name: 'Session statistics' })
    expect(dialog.textContent).toContain('LLM time1m1s')
    expect(dialog.textContent).toContain('Tool time3s')
    expect(dialog.textContent).toContain('Avg time to first token (TTFT)0.2s')
    expect(dialog.textContent).toContain('Tokens per second (TPS)40 tok/s')
  })

  it('does not render an empty row before a turn or usage exists', () => {
    const view = renderPills({
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sessionStats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    })
    expect(view.container.querySelector('[data-composer-stats]')).toBeNull()
  })
})
