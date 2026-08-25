// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { holdInert } from '../src/inert.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('holdInert', () => {
  it('holds native and fallback accessibility state, then restores it', () => {
    const root = document.createElement('div')
    const button = document.createElement('button')
    const link = document.createElement('a')
    link.href = '/docs'
    root.append(button, link)
    document.body.append(root)
    button.focus()

    const release = holdInert(root)
    expect(root.inert).toBe(true)
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(button.tabIndex).toBe(-1)
    expect(link.tabIndex).toBe(-1)

    release()
    expect(root.inert).toBe(false)
    expect(root.hasAttribute('aria-hidden')).toBe(false)
    expect(button.tabIndex).toBe(0)
    expect(link.tabIndex).toBe(0)
  })

  it('restores nested holds in stack order', () => {
    const root = document.createElement('div')
    root.setAttribute('aria-hidden', 'false')
    document.body.append(root)
    const first = holdInert(root)
    const second = holdInert(root)
    second()
    expect(root.inert).toBe(true)
    expect(root.getAttribute('aria-hidden')).toBe('true')
    first()
    expect(root.inert).toBe(false)
    expect(root.getAttribute('aria-hidden')).toBe('false')
  })
})
