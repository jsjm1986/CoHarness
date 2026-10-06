/** A personal managed runtime can load without installing project collaboration. */
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { registerWebhookDispatch } from '../src/webhook.ts'

vi.mock('@deepseek-ai/dsh-collaboration', () => { throw new Error('optional collaboration package is not installed') })

it('keeps route composition available without the optional collaboration package', () => {
  const injected = vi.fn()
  const cleanup: Array<() => void> = []
  const ctx = {
    get: () => undefined,
    effect: (effect: () => () => void) => { cleanup.push(effect()) },
    inject: (dependencies: readonly string[], callback: (context: Context) => void) => {
      injected(dependencies)
      callback(ctx as unknown as Context)
    },
  }
  try {
    registerWebhookDispatch(ctx as unknown as Context, new AbortController().signal)
    expect(injected).toHaveBeenCalledOnce()
    expect(cleanup).toHaveLength(1)
  } finally { for (const dispose of cleanup) dispose() }
})
