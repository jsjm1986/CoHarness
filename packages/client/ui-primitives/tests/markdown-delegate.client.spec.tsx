// @vitest-environment jsdom
/** Delegated Markdown anchors preserve native modified activation and streaming callback currency. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '../src/markdown/MarkdownDelegate.tsx'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

it('delegates ordinary HTTP(S) clicks and leaves modified or non-HTTP clicks native', () => {
  const open = vi.fn()
  const view = render(<MarkdownDelegateProvider openExternalLink={open}><MarkdownText text="[Preview](https://example.test/) [Mail](mailto:someone@example.test)" /></MarkdownDelegateProvider>)
  const link = view.getByRole('link', { name: 'Preview' })
  expect(fireEvent.click(link)).toBe(false)
  expect(open).toHaveBeenCalledWith('https://example.test/')
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    expect(fireEvent.click(link, modifiers)).toBe(true)
  }
  expect(fireEvent.click(view.getByRole('link', { name: 'Mail' }))).toBe(true)
  expect(open).toHaveBeenCalledTimes(1)
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
})

it('updates delegation on frozen streaming links without changing their DOM or reparsing the message', () => {
  const first = vi.fn()
  const second = vi.fn()
  const text = '[Preview](https://example.test/)\n\nOne\n\nTwo\n\nTail'
  const view = render(<MarkdownDelegateProvider openExternalLink={first}><MarkdownText text={text} streaming /></MarkdownDelegateProvider>)
  const link = view.getByRole('link', { name: 'Preview' })
  fireEvent.click(link)
  view.rerender(<MarkdownDelegateProvider openExternalLink={second}><MarkdownText text={text} streaming /></MarkdownDelegateProvider>)
  expect(view.getByRole('link', { name: 'Preview' })).toBe(link)
  fireEvent.click(link)
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
})
