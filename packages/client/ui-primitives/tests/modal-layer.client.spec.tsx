// @vitest-environment jsdom
/** Modal isolation and focus ownership across independent portal lifetimes. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { useRef } from 'react'
import { Modal } from '../src/Modal.tsx'
import { ImageLightbox } from '../src/ImageLightbox.tsx'
import { useModalLayer } from '../src/useModalLayer.ts'

afterEach(() => { cleanup(); document.body.replaceChildren() })

it('isolates background controls and preserves the original opener when a lower modal closes first', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const outerClose = vi.fn()
  const innerClose = vi.fn()
  const content = (outer: boolean, inner: boolean) => <>
    <Modal open={outer} title="Outer" closeLabel="Close outer" onClose={outerClose}><button type="button">Open image</button></Modal>
    {inner && <ImageLightbox src="https://example.test/image.png" alt="Preview" labels={{ dialog: 'Image', close: 'Close image' }} onClose={innerClose} />}
  </>
  const view = render(content(true, false))
  expect(opener.inert).toBe(true)
  screen.getByRole('button', { name: 'Open image' }).focus()
  view.rerender(content(true, true))
  const image = screen.getByRole('dialog', { name: 'Image' })
  expect(screen.queryByRole('dialog', { name: 'Outer' })).toBeNull()
  fireEvent.keyDown(image, { key: 'Escape' })
  expect(innerClose).toHaveBeenCalledOnce()
  expect(outerClose).not.toHaveBeenCalled()
  view.rerender(content(false, true))
  expect(opener.inert).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close image' }))
  view.rerender(content(false, false))
  expect(opener.inert).toBe(false)
  expect(document.activeElement).toBe(opener)
})

it('isolates ancestor siblings for a dialog portaled inside the application and skips hidden tab stops', () => {
  const app = document.createElement('div')
  const outside = document.createElement('button')
  const portal = document.createElement('div')
  app.append(outside, portal)
  document.body.append(app)
  outside.focus()
  function Inner() {
    const dialog = useRef<HTMLDivElement>(null)
    useModalLayer(dialog, true, vi.fn())
    return createPortal(<div ref={dialog} role="dialog" aria-modal="true" tabIndex={-1}>
      <button type="button">First</button><button type="button" style={{ display: 'none' }}>Hidden</button><button type="button">Last</button>
    </div>, portal)
  }
  const view = render(<Inner />)
  expect(outside.inert).toBe(true)
  expect(portal.inert).not.toBe(true)
  screen.getByRole('button', { name: 'Last' }).focus()
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }))
  view.unmount()
  expect(outside.inert).toBe(false)
  expect(document.activeElement).toBe(outside)
})
