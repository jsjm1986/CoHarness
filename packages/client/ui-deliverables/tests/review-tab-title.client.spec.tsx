// @vitest-environment jsdom
/** The changes-review chip carries the review glyph and the captured title. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ReviewTabTitle } from '../src/client/ReviewTabTitle.tsx'

function props(title: string): Parameters<typeof ReviewTabTitle>[0] {
  return {
    useTabInfo: () => ({ tab: { title } }),
  } as Parameters<typeof ReviewTabTitle>[0]
}

afterEach(cleanup)

describe('ReviewTabTitle', () => {
  it('renders the file-pen glyph before the registry title', () => {
    const view = render(<ReviewTabTitle {...props('Turn 2 review')} />)
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.container.textContent).toBe('Turn 2 review')
  })
})
