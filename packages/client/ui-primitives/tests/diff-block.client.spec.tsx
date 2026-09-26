// @vitest-environment jsdom
// Bounded inline diffs, neutral context, complete copying, and collapsed presentation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { DEFAULT_DIFF_MAX_LINES, DiffBlock as LocalizedDiffBlock, type DiffHunk } from '../src/index.ts'
import { diffBlockLabels } from './labels.client.ts'

function DiffBlock(props: Omit<ComponentProps<typeof LocalizedDiffBlock>, 'labels'>) {
  return <LocalizedDiffBlock {...props} labels={diffBlockLabels} />
}

afterEach(cleanup)

beforeEach(() => {
  vi.useRealTimers()
})

/** The rendered body rows, one string per visible line (CSS-module class prefix). */
function bodyRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class*="_line_"]')].map(row => row.textContent ?? '')
}

/** Only the changed rows (add/del), excluding the path header and gap chrome. */
function changeRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class*="_del_"], [class*="_add_"]')].map(row => row.textContent ?? '')
}

/** `count` numbered added lines as one hunk's newText. */
function added(count: number): string {
  return Array.from({ length: count }, (_v, i) => `line ${i + 1}`).join('\n')
}

describe('DiffBlock structure', () => {
  it('renders a create as a path header and an added block (no removed side)', () => {
    const diffs: DiffHunk[] = [{ path: 'notes/new.txt', oldText: null, newText: 'hello\nworld' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(screen.getByText('notes/new.txt')).toBeTruthy()
    // No removed rows: both change lines are added.
    expect(changeRows(container)).toEqual(['hello', 'world'])
    expect(container.querySelectorAll('[class*="_del_"]').length).toBe(0)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(2)
  })

  it('renders an edit as a removed block above an added block', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: 'old', newText: 'new' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(container.querySelectorAll('[class*="_del_"]').length).toBe(1)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(1)
    expect(changeRows(container)).toEqual(['old', 'new'])
  })

  it('opens a same-file second hunk with a gap instead of repeating the path', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ]
    const { container } = render(<DiffBlock diffs={diffs} />)
    // One path header, one gap row.
    expect(container.querySelectorAll('[class*="_path_"]').length).toBe(1)
    expect(container.querySelectorAll('[class*="_gap_"]').length).toBe(1)
  })

  it('opens a new file with its own path header', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { path: 'b.ts', oldText: 'p', newText: 'q' },
    ]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(container.querySelectorAll('[class*="_path_"]').length).toBe(2)
    expect(container.querySelectorAll('[class*="_gap_"]').length).toBe(0)
  })

  it('renders nothing for empty diffs', () => {
    const { container } = render(<DiffBlock diffs={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('treats a trailing newline as a terminator, not an extra blank line', () => {
    // A create whose newText ends in a newline is one added line, not two, and
    // the footer counts one — the phantom `+ ` empty line the naive split drew.
    const { container } = render(<DiffBlock diffs={[{ path: 'n.txt', oldText: null, newText: 'hello\n' }]} />)
    expect(changeRows(container)).toEqual(['hello'])
    expect(screen.getByText('└ +1 -0 · 1 file')).toBeTruthy()
  })

  it('renders a full deletion as removed-only with no phantom added line', () => {
    // newText '' is zero added lines: an empty string must contribute nothing.
    const { container } = render(<DiffBlock diffs={[{ path: 'gone.ts', oldText: 'a\nb', newText: '' }]} />)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(0)
    expect(screen.getByText('└ +0 -2 · 1 file')).toBeTruthy()
  })

  it('keeps a genuine interior blank line', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x\n\ny' }]} />)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(3)
  })
})

describe('DiffBlock footer', () => {
  it('counts added and removed lines and one file', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: 'a\nb', newText: 'c' }]
    render(<DiffBlock diffs={diffs} />)
    expect(screen.getByText('└ +1 -2 · 1 file')).toBeTruthy()
  })

  it('pluralizes the distinct-file count', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: null, newText: 'x' },
      { path: 'b.ts', oldText: null, newText: 'y' },
    ]
    render(<DiffBlock diffs={diffs} />)
    expect(screen.getByText('└ +2 -0 · 2 files')).toBeTruthy()
  })
})

describe('DiffBlock exact local changes', () => {
  it('keeps shared lines as neutral context and counts only the changed line', () => {
    const { container } = render(<DiffBlock diffs={[{
      path: 'context.txt', oldText: 'before\nold\nafter\n', newText: 'before\nnew\nafter\n',
    }]} />)
    expect(changeRows(container)).toEqual(['old', 'new'])
    expect([...container.querySelectorAll('[class*="_context_"]')].map(row => row.textContent)).toEqual(['before', 'after'])
    expect(screen.getByText('└ +1 -1 · 1 file')).toBeTruthy()
  })

  it('reports no additions or deletions for identical content or its terminating newline', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'same.txt', oldText: 'same\n', newText: 'same' }]} />)
    expect(changeRows(container)).toEqual([])
    expect(bodyRows(container)).toEqual(['same.txt'])
    expect(screen.getByText('└ +0 -0 · 1 file')).toBeTruthy()
  })

  it('retains three context lines on each side of distant edits and separates the patches', () => {
    const original = Array.from({ length: 20 }, (_, index) => `line ${index}`)
    const changed = [...original]
    changed[2] = 'changed 2'
    changed[17] = 'changed 17'
    const { container } = render(<DiffBlock diffs={[{
      path: 'distant.txt', oldText: original.join('\n'), newText: changed.join('\n'),
    }]} maxLines={Infinity} />)
    expect(bodyRows(container)).toEqual([
      'distant.txt', 'line 0', 'line 1', 'line 2', 'changed 2', 'line 3', 'line 4', 'line 5',
      '⋯', 'line 14', 'line 15', 'line 16', 'line 17', 'changed 17', 'line 18', 'line 19',
    ])
    expect(screen.getByText('└ +2 -2 · 1 file')).toBeTruthy()
  })

  it.each([128, 129])('bounds comparison at 256 edits for %i replaced lines', (count) => {
    const oldLines = ['shared', ...Array.from({ length: count }, (_, index) => `old ${index}`)]
    const newLines = ['shared', ...Array.from({ length: count }, (_, index) => `new ${index}`)]
    const { container } = render(<DiffBlock diffs={[{
      path: 'large.txt', oldText: oldLines.join('\n'), newText: newLines.join('\n'),
    }]} maxLines={Infinity} />)
    const expected = count === 128 ? count : count + 1
    expect(screen.getByText(`└ +${expected} -${expected} · 1 file`)).toBeTruthy()
    expect(container.querySelectorAll('[class*="_context_"]')).toHaveLength(count === 128 ? 1 : 0)
    expect(changeRows(container)).toHaveLength(expected * 2)
  })

  it('copies all context and changes while the visible rows are collapsed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      render(<DiffBlock diffs={[{
        path: 'copy.txt', oldText: 'before\n+literal\nold\nafter\n', newText: 'before\n+literal\nnew\nafter\n',
      }]} maxLines={3} />)
      expect(screen.getByRole('button', { name: /展开其余/ })).toBeTruthy()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
      expect(writeText).toHaveBeenCalledWith('copy.txt\n  before\n  +literal\n- old\n+ new\n  after')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', previous)
    }
  })
})

describe('DiffBlock height cap', () => {
  it('shows head and tail with an expand control past the cap, then all lines expanded', () => {
    // One added line over the default cap forces the collapse.
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: null, newText: added(DEFAULT_DIFF_MAX_LINES) }]
    // The path header counts as a row, so a body of maxLines added lines plus
    // the header is one over the cap.
    const { container } = render(<DiffBlock diffs={diffs} />)
    const toggle = screen.getByRole('button', { name: /展开其余/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Collapsed shows fewer rows than the full body.
    const collapsedCount = bodyRows(container).length
    expect(collapsedCount).toBeLessThan(DEFAULT_DIFF_MAX_LINES + 1)
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '收起差异' }).getAttribute('aria-expanded')).toBe('true')
    expect(bodyRows(container).length).toBeGreaterThan(collapsedCount)
  })

  it('shows no expand control at or under the cap', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: null, newText: added(4) }]
    render(<DiffBlock diffs={diffs} maxLines={16} />)
    expect(screen.queryByRole('button', { name: /展开其余|收起差异/ })).toBeNull()
  })
})

describe('DiffBlock copy', () => {
  it('copies the prefixed diff text and flips the label on success', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'old', newText: 'new' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ]
    render(<DiffBlock diffs={diffs} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    // Path header, del/add prefixes, and the same-file gap all reach the clipboard.
    expect(writeText).toHaveBeenCalledWith('a.ts\n- old\n+ new\n⋯\n- p\n+ q')
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('keeps the label on a refused clipboard write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('ignores a second click while the copied label is showing', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制成功' })) })
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
