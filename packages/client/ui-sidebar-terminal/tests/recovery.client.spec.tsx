// @vitest-environment jsdom
/** Session terminal recovery hides ordinary work and keeps failed lookup retryable. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { TerminalRecovery } from '../src/client/TerminalRecovery.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function props(restore: Parameters<typeof TerminalRecovery>[0]['restore'], ownership: SnapshotStore<string | undefined> = createSnapshotStore<string | undefined>('owner')): Parameters<typeof TerminalRecovery>[0] {
  // The renderer supplies Session shares; recovery reads its private ownership hook.
  return { restore, useOwnership: bindSnapshotSelector(ownership), t: makeTranslate(en) } as Parameters<typeof TerminalRecovery>[0]
}

it('waits for verified ownership and recovers automatically when the account becomes ready', async () => {
  const ownership = createSnapshotStore<string | undefined>(undefined)
  const restore = vi.fn(async () => {})
  const view = render(<TerminalRecovery {...props(restore, ownership)} />)
  expect(restore).not.toHaveBeenCalled()
  expect(view.container.childElementCount).toBe(0)
  await act(async () => { ownership.set('account:1') })
  expect(restore).toHaveBeenCalledOnce()
  expect(view.container.childElementCount).toBe(0)
})

it('retires the previous account attempt and its error when ownership is withdrawn and replaced', async () => {
  const ownership = createSnapshotStore<string | undefined>('account:1')
  const previous = Promise.withResolvers<undefined>()
  const restore = vi.fn<Parameters<typeof TerminalRecovery>[0]['restore']>()
    .mockImplementationOnce(() => previous.promise).mockResolvedValue(undefined)
  const view = render(<TerminalRecovery {...props(restore, ownership)} />)
  try {
    const original = restore.mock.calls[0]![0]
    await act(async () => { ownership.set(undefined) })
    expect(original.aborted).toBe(true)
    expect(restore).toHaveBeenCalledOnce()
    expect(view.container.childElementCount).toBe(0)
    await act(async () => { ownership.set('account:2') })
    expect(restore).toHaveBeenCalledTimes(2)
    await act(async () => { previous.reject(new Error('Previous account failed')); await Promise.allSettled([previous.promise]) })
    expect(view.container.childElementCount).toBe(0)
  } finally {
    previous.resolve(undefined)
    await act(async () => { await Promise.allSettled([previous.promise]) })
  }
})

it('aborts the recovery consumer when the composer unmounts', async () => {
  const pending = Promise.withResolvers<undefined>()
  const restore = vi.fn<Parameters<typeof TerminalRecovery>[0]['restore']>(() => pending.promise)
  const view = render(<TerminalRecovery {...props(restore)} />)
  try {
    const signal = restore.mock.calls[0]![0]
    view.unmount()
    expect(signal.aborted).toBe(true)
    pending.resolve(undefined)
    await act(async () => { await pending.promise })
  } finally {
    pending.resolve(undefined)
    await act(async () => { await pending.promise })
  }
})

it('restores on mount without adding controls during a successful lookup', async () => {
  const pending = Promise.withResolvers<undefined>()
  const restore = vi.fn(() => pending.promise)
  const view = render(<TerminalRecovery {...props(restore)} />)
  try {
    expect(restore).toHaveBeenCalledOnce()
    expect(view.container.childElementCount).toBe(0)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    view.rerender(<TerminalRecovery {...props(restore)} />)
    expect(restore).toHaveBeenCalledOnce()
    expect(view.container.childElementCount).toBe(0)
  } finally {
    await act(async () => { pending.resolve(undefined); await pending.promise })
  }
})

it.each([new Error('Host unavailable'), 'Host unavailable'])('offers recovery retry for a failed lookup: %s', async (reason) => {
  const pending = Promise.withResolvers<undefined>()
  const restore = vi.fn<() => Promise<void>>().mockRejectedValueOnce(reason).mockImplementationOnce(() => pending.promise)
  const view = render(<TerminalRecovery {...props(restore)} />)
  try {
    const retry = await view.findByRole('button', { name: en.retryRecovery })
    expect(retry.getAttribute('title')).toBe('Terminal recovery failed: Host unavailable')
    fireEvent.click(retry)
    expect(restore).toHaveBeenCalledTimes(2)
    expect(view.container.childElementCount).toBe(0)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(view.container.childElementCount).toBe(0)
  } finally {
    await act(async () => { pending.resolve(undefined); await pending.promise })
  }
})

it('keeps the current Session failure when an earlier Session lookup later succeeds', async () => {
  const pending = Promise.withResolvers<undefined>()
  const previous = vi.fn(() => pending.promise)
  const current = vi.fn(async () => { throw new Error('Current Session failed') })
  const view = render(<TerminalRecovery {...props(previous)} />)
  try {
    view.rerender(<TerminalRecovery {...props(current)} />)
    const retry = await view.findByRole('button', { name: en.retryRecovery })
    expect(retry.getAttribute('title')).toContain('Current Session failed')
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(view.getByRole('button', { name: en.retryRecovery }).getAttribute('title')).toContain('Current Session failed')
  } finally {
    await act(async () => { pending.resolve(undefined); await pending.promise })
  }
})

it('ignores an earlier Session failure after a replacement Session recovers', async () => {
  const pending = Promise.withResolvers<undefined>()
  const previous = vi.fn(() => pending.promise)
  const completed = Promise.resolve()
  const current = vi.fn(() => completed)
  const view = render(<TerminalRecovery {...props(previous)} />)
  try {
    view.rerender(<TerminalRecovery {...props(current)} />)
    await act(async () => { await completed })
    await act(async () => {
      pending.reject(new Error('Previous Session failed'))
      await expect(pending.promise).rejects.toThrow('Previous Session failed')
    })
    expect(view.container.childElementCount).toBe(0)
  } finally {
    pending.resolve(undefined)
    await Promise.allSettled([pending.promise])
  }
})
