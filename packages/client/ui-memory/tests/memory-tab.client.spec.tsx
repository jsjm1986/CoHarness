// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MemoryEntry } from '@deepseek-ai/dsh-memory/client'
import { MemoryTab, type MemoryTabProps } from '../src/client/MemoryTab.tsx'
import type { MemorySnapshot } from '../src/client/memory-source.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const messages: Readonly<Record<string, string>> = en

function mount(overrides: Partial<MemoryTabProps> = {}) {
  const entry: MemoryEntry = {
    scope: { kind: 'personal' }, key: 'keyboard-entry' as MemoryEntry['key'], kind: 'guidance',
    summary: 'A searchable summary', content: 'Full memory content', revision: 'revision-1' as MemoryEntry['revision'],
    created: { source: 'member', at: '2026-01-01T12:00:00Z' },
    updated: { source: 'member', at: '2026-01-01T12:00:00Z' },
  }
  const snapshot: MemorySnapshot = {
    status: 'ready', enabled: true, scopes: [{ scope: { kind: 'personal' }, writable: true, entries: 1 }],
    selected: 'personal', entries: [entry], entriesFailed: false, settled: true,
  }
  const props: MemoryTabProps = {
    t: key => messages[key] ?? key,
    useMemory: select => select(snapshot),
    useSessions: select => select({ phase: 'ready', state: 'idle', error: null, current: undefined, currentAddress: undefined,
      ids: [], byId: {}, archivedById: {}, subagentsByParent: {}, jobsBySession: {}, observedJobs: {} }),
    useWorkspaces: select => select({ phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [],
      pinnedSessionIds: [], baselinesReady: true, recentWorkspaceId: undefined }),
    select: vi.fn(), refresh: vi.fn(), save: vi.fn(), remove: vi.fn(), openSource: vi.fn(),
    ...overrides,
  }
  return render(<MemoryTab {...props} />)
}

describe('Memory tab accessible controls', () => {
  it.each(['cancel', 'collapse'] as const)('%s discards a deletion confirmation and its refusal without deleting again', async (dismiss) => {
    const remove = vi.fn<MemoryTabProps['remove']>(async () => ({ ok: true, value: { ok: false, code: 'memory_stale' } }))
    mount({ remove })
    const disclosure = screen.getByRole('button', { name: /keyboard-entry/ })
    fireEvent.click(disclosure)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['refusal.memory_stale']) })
    if (dismiss === 'cancel') {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(document.activeElement).toBe(disclosure)
    } else {
      fireEvent.click(disclosure)
      fireEvent.click(disclosure)
    }
    expect(screen.queryByText(en['editor.confirmDelete'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Full memory content')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText(en['editor.confirmDelete'])).toBeTruthy()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it.each(['timeline', 'editor'] as const)('%s keeps a refused deletion visible and reports its revision conflict', async (surface) => {
    const remove = vi.fn<MemoryTabProps['remove']>(async () => ({ ok: true, value: { ok: false, code: 'memory_stale' } }))
    mount({ remove })
    fireEvent.click(screen.getByRole('button', { name: /keyboard-entry/ }))
    if (surface === 'editor') fireEvent.click(screen.getByRole('button', { name: 'Edit memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    if (surface === 'timeline') fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['refusal.memory_stale']) })
    expect(remove).toHaveBeenCalledTimes(1)
    if (surface === 'editor') expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Content' }).value).toBe('Full memory content')
    else expect(screen.getByText('Full memory content')).toBeTruthy()
  })

  it.each(['timeline', 'editor'] as const)('%s contains a rejected delete request and permits retry', async (surface) => {
    const remove = vi.fn<MemoryTabProps['remove']>().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'memory_not_found' } })
    mount({ remove })
    fireEvent.click(screen.getByRole('button', { name: /keyboard-entry/ }))
    if (surface === 'editor') fireEvent.click(screen.getByRole('button', { name: 'Edit memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    if (surface === 'timeline') fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['editor.deleteFailed']) })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['refusal.memory_not_found']) })
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('exposes a focusable entry disclosure with its expanded state', () => {
    mount()
    const disclosure = screen.getByRole('button', { name: /keyboard-entry/, expanded: false })
    disclosure.focus()
    expect(document.activeElement).toBe(disclosure)
    expect(disclosure.tagName).toBe('BUTTON')
    expect(screen.queryByText('Full memory content')).toBeNull()
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Full memory content')).toBeTruthy()
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Full memory content')).toBeNull()
  })

  it('labels search and every editor field and describes key and summary hints', () => {
    mount()
    expect(screen.getByRole('textbox', { name: 'Search memory' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    expect(screen.getByRole('combobox', { name: 'Kind' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Content' })).toBeTruthy()
    for (const [name, hint] of [['Key', en['editor.keyHint']], ['Summary', en['editor.summaryHint']]] as const) {
      const field = screen.getByRole('textbox', { name })
      const description = field.getAttribute('aria-describedby')
      expect(description).not.toBeNull()
      expect(document.getElementById(description!)?.textContent).toBe(hint)
    }
  })
})
