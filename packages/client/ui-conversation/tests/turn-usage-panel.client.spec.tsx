// @vitest-environment jsdom
/** Per-turn usage and time pills: compact labels open bounded detail dialogs. */
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { en } from '../src/client/locales.ts'
import { TurnTimePanel, TurnUsagePanel } from '../src/client/chat/TurnUsagePanel.tsx'

afterEach(() => { document.body.innerHTML = '' })

const t = makeTranslate(en, commonEn)

describe('TurnUsagePanel', () => {
  it('shows the compact total and exact cache buckets', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      outputTokens: 20,
      totalTokens: 1_020,
      routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    }
    const view = render(<TurnUsagePanel usage={usage} t={t} />)
    const trigger = view.getByRole('button', { name: 'Usage 1K tok · Cache hit 90%' })
    fireEvent.click(trigger)
    const dialog = view.getByRole('dialog', { name: 'Turn usage' })
    expect(dialog.textContent).toContain('Cache hit90%')
    expect(dialog.textContent).toContain('Uncached input100 tok')
    expect(dialog.textContent).toContain('Cached input900 tok')
    expect(dialog.textContent).toContain('Output20 tok')
  })

  it('shows turn duration and timing details in the existing clock contract', () => {
    const view = render(<TurnTimePanel runMs={3_903_000} ttftMs={1_200} tokensPerSecond={20} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Ran for 1h 05m 03s' }))
    const dialog = view.getByRole('dialog', { name: 'Turn time and speed' })
    expect(dialog.textContent).toContain('Total run time1h 05m 03s')
    expect(dialog.textContent).toContain('Tokens per second (TPS)20 tok/s')
    expect(dialog.textContent).toContain('Time to first token (TTFT)1.2s')
  })
})
