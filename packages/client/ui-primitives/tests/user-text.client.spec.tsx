// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { projectUserText } from '../src/user-text.tsx'

afterEach(cleanup)

function chips(container: HTMLElement): { label: string; kind: string; title: string }[] {
  return [...container.querySelectorAll<HTMLElement>('[data-ref-chip]')].map(chip => ({
    label: chip.textContent ?? '',
    kind: chip.dataset['refChip'] ?? '',
    title: chip.title,
  }))
}

describe('projectUserText', () => {
  it('returns one plain run when nothing decorates', () => {
    const { container } = render(<>{projectUserText('plain message', [])}</>)
    expect(container.textContent).toBe('plain message')
    expect(chips(container)).toEqual([])
  })

  it('folds the wire session form to its label and keeps surrounding runs', () => {
    const { container } = render(<>{projectUserText('see @[my session](dsh-session:abc-123) please', [])}</>)
    expect(chips(container)).toEqual([
      { label: 'my session', kind: 'session', title: '@[my session](dsh-session:abc-123)' },
    ])
    expect(container.textContent).toContain('see ')
    expect(container.textContent).toContain(' please')
  })

  it('decorates bare @labels supplied by an adjacent recall, longest first and every occurrence', () => {
    const { container } = render(<>{projectUserText('@alpha then @alpha-beta and @alpha again', ['alpha', 'alpha-beta', 'alpha'])}</>)
    const found = chips(container)
    expect(found.map(chip => chip.label)).toEqual(['alpha', 'alpha-beta', 'alpha'])
    expect(found.every(chip => chip.kind === 'session')).toBe(true)
  })

  it('decorates a /name token only when the caller names it, under the chosen kind', () => {
    const { container } = render(<>{projectUserText('run /review and /unknown', [], ['review'], 'command')}</>)
    expect(chips(container)).toEqual([{ label: '/review', kind: 'command', title: '/review' }])
    expect(container.textContent).toContain(' and /unknown')
  })

  it('keeps slash paths, numbers, and punctuation-glued tokens plain', () => {
    const { container } = render(<>{projectUserText('/nfs-hg/xxx /123 /plan。', [], ['plan'])}</>)
    expect(chips(container)).toEqual([])
  })

  it('decorates @file and @folder tokens and sheds trailing sentence punctuation', () => {
    const { container } = render(<>{projectUserText('open @src/app.ts, then @docs/!', [])}</>)
    expect(chips(container)).toEqual([
      { label: 'app.ts', kind: 'file', title: '@src/app.ts' },
      { label: 'docs', kind: 'folder', title: '@docs/' },
    ])
    expect(container.textContent).toContain(', then ')
    expect(container.textContent).toContain('!')
  })

  it('decorates a quoted @path as a file and shows its basename', () => {
    const { container } = render(<>{projectUserText('check @"dir with space/read me.md" now', [])}</>)
    expect(chips(container)).toEqual([
      { label: 'read me.md', kind: 'file', title: '@"dir with space/read me.md"' },
    ])
  })

  it('skips a bare @-punctuation token and tokens covered by an earlier range', () => {
    const { container } = render(<>{projectUserText('@, and @[inside](dsh-session:x) @inside', ['inside'])}</>)
    // `@,` sheds its comma and dies at the length guard; the recall label inside
    // the wire range loses the overlap race to it.
    const found = chips(container)
    expect(found.map(chip => chip.label)).toEqual(['inside', 'inside'])
  })

  it('keeps only the basename of a folder chip', () => {
    const { container } = render(<>{projectUserText('into @a/b/c/', [])}</>)
    expect(chips(container)).toEqual([{ label: 'c', kind: 'folder', title: '@a/b/c/' }])
  })

  it('falls back to the raw label when the path basename is empty', () => {
    const { container } = render(<>{projectUserText('root @/ here', [])}</>)
    expect(chips(container)).toEqual([{ label: '/', kind: 'folder', title: '@/' }])
  })
})
