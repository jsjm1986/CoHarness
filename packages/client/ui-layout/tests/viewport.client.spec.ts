import { describe, expect, it } from 'vitest'
import {
  VIEWPORT_EXPANDED_MIN, VIEWPORT_MEDIUM_MIN, VIEWPORT_SHORT_HEIGHT_MAX, VIEWPORT_WIDE_MIN,
  isShortCompactViewport, viewportClassOf,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/viewport.ts'
import { SIDEBAR_AUTO_COLLAPSE } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

describe('viewportClassOf', () => {
  it('classifies each range and its boundaries', () => {
    expect(viewportClassOf(320)).toBe('compact')
    expect(viewportClassOf(VIEWPORT_MEDIUM_MIN - 1)).toBe('compact')
    expect(viewportClassOf(VIEWPORT_MEDIUM_MIN)).toBe('medium')
    expect(viewportClassOf(VIEWPORT_EXPANDED_MIN - 1)).toBe('medium')
    expect(viewportClassOf(VIEWPORT_EXPANDED_MIN)).toBe('expanded')
    expect(viewportClassOf(VIEWPORT_WIDE_MIN - 1)).toBe('expanded')
    expect(viewportClassOf(VIEWPORT_WIDE_MIN)).toBe('wide')
  })

  it('the sidebar auto-collapse breakpoint is the medium/expanded boundary', () => {
    expect(SIDEBAR_AUTO_COLLAPSE).toBe(VIEWPORT_EXPANDED_MIN)
  })

  it('only marks phone-width frames below the short-screen height', () => {
    expect(isShortCompactViewport(390, VIEWPORT_SHORT_HEIGHT_MAX - 1)).toBe(true)
    expect(isShortCompactViewport(390, VIEWPORT_SHORT_HEIGHT_MAX)).toBe(false)
    expect(isShortCompactViewport(VIEWPORT_MEDIUM_MIN, 600)).toBe(false)
  })
})
