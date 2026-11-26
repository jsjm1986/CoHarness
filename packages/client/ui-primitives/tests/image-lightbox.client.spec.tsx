// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ImageLightbox } from '../src/ImageLightbox.tsx'

afterEach(cleanup)

const labels = { dialog: '原图预览', close: '关闭原图预览' }

describe('ImageLightbox', () => {
  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    const outerKey = vi.fn<(event: KeyboardEvent) => void>()
    document.addEventListener('keydown', outerKey)
    try {
      fireEvent.keyDown(close, { key: 'Escape' })
      expect(outerKey.mock.calls[0]?.[0].defaultPrevented).toBe(true)
    } finally { document.removeEventListener('keydown', outerKey) }
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = view.getByRole('dialog').querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the opener across callback changes and uses the current close action', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    try {
      opener.focus()
      const first = vi.fn()
      const next = vi.fn()
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={first} />)
      view.rerender(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={next} />)
      fireEvent.keyDown(view.getByRole('button', { name: labels.close }), { key: 'Escape' })
      expect(first).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledOnce()
      view.unmount()
      expect(document.activeElement).toBe(opener)
    } finally { opener.remove() }
  })

  it('leaves composition dismissal and modified Escape with their keyboard owner', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: labels.close })
    fireEvent.compositionStart(close)
    fireEvent.keyDown(close, { key: 'Escape' })
    fireEvent.compositionEnd(close)
    fireEvent.keyDown(close, { key: 'Escape' })
    fireEvent.keyDown(close, { key: 'Escape', ctrlKey: true })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
