// @vitest-environment jsdom
/** The workspace-file chip shows the path's type glyph and basename. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { WorkspaceFileTitle } from '../src/client/components/WorkspaceFileTitle.tsx'

function props(title: string): Parameters<typeof WorkspaceFileTitle>[0] {
  return {
    useTabInfo: () => ({ tab: { title } }),
  } as Parameters<typeof WorkspaceFileTitle>[0]
}

afterEach(cleanup)

describe('WorkspaceFileTitle', () => {
  it('renders the classified file glyph and the basename', () => {
    const view = render(<WorkspaceFileTitle {...props('/repo/src/nav-a.md')} />)
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.container.textContent).toBe('nav-a.md')
  })

  it('reads basenames past either separator and keeps a nameless title verbatim', () => {
    const view = render(<WorkspaceFileTitle {...props('C:\\work\\pkg\\main.ts')} />)
    expect(view.container.textContent).toBe('main.ts')
    cleanup()
    const bare = render(<WorkspaceFileTitle {...props('')} />)
    expect(bare.container.textContent).toBe('')
    const nameless = render(<WorkspaceFileTitle {...props('/repo/dir/')} />)
    expect(nameless.container.textContent).toBe('/repo/dir/')
  })
})
