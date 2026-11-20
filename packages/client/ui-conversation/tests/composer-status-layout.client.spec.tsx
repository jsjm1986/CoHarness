// @vitest-environment jsdom
/** Composer status triggers keep their mounted state and focus during relocation. */
import { useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { renderToString } from 'react-dom/server'
import { act, cleanup, render, renderHook, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useComposerStatusLayout } from '../src/client/skeleton/useComposerStatusLayout.ts'

const contents = { display: 'contents' }
const atomicMove = vi.fn(function (this: Element, child: Node) { this.appendChild(child) })

function Toolbar({ width, viewport = 'compact', touchSize = '44px', withStatus = true, touch }: {
  width: number
  viewport?: string
  touchSize?: string
  withStatus?: boolean
  touch?: boolean
}) {
  const row = useRef<HTMLDivElement>(null)
  const { context, status } = useComposerStatusLayout(row)
  return <div data-viewport={viewport} data-composer-tool-layout={touch === undefined ? undefined : touch ? 'compact' : 'default'}>
    <div ref={row} data-width={width} style={{ '--dsw-touch-target': touchSize } as CSSProperties} role="toolbar">
      <div>
        <button data-width={44}>Attach</button>
        <button data-width={44}>Documents</button>
        <div style={contents}>
          <button data-width={44}>Commands</button>
          <button data-width={44}>Permissions</button>
          <span data-width={44} style={{ display: 'none' }} />
          <span data-width={200} style={{ position: 'absolute' }} />
          <span data-width={200} style={{ position: 'fixed' }} />
          <span data-width={0} />
        </div>
        <div ref={status.toolbar} style={contents} />
      </div>
      <div>
        <button data-width={44}>Model</button>
        <div ref={context.toolbar} style={contents} />
        <button data-width={44}>Send</button>
      </div>
    </div>
    <div aria-label="Footer" role="group">
      <div ref={context.footer} />
      <div ref={(element) => {
        status.footer.current = element
        if (element !== null) element.moveBefore = atomicMove
      }} />
    </div>
    {context.mount && createPortal(<button>Context used 10%</button>, context.mount)}
    {status.mount && createPortal(withStatus ? <button>Maintenance</button> : null, status.mount)}
  </div>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  atomicMove.mockClear()
})

it('fits the real controls, then moves the context trigger and the optional status in order', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, Number(this.dataset.width ?? 0), 44)
  })
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  let resized: ResizeObserverCallback | undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback }
    observe() {}
    disconnect() {}
  })
  const view = render(<Toolbar width={355} touch={false} />)
  const toolbar = view.getByRole('toolbar')
  const footer = view.getByRole('group', { name: 'Footer' })
  const meter = view.getByRole('button', { name: 'Context used 10%' })
  const shield = view.getByRole('button', { name: 'Maintenance' })
  const gap = () => toolbar.style.getPropertyValue('--composer-tool-gap')
  function resize(props: Parameters<typeof Toolbar>[0]): void {
    view.rerender(<Toolbar touch={false} {...props} />)
    resized!([], {} as ResizeObserver)
    act(() => {
      for (const [id, callback] of frames) {
        frames.delete(id)
        callback(0)
      }
    })
  }

  expect(gap()).toBe('max(0px, (100cqi - 352px) / 7)')
  expect(toolbar.contains(meter)).toBe(true)
  expect(toolbar.contains(shield)).toBe(true)
  resize({ width: 355 })
  meter.focus()
  resize({ width: 332 })
  expect(footer.contains(meter)).toBe(true)
  expect(toolbar.contains(shield)).toBe(true)
  expect(document.activeElement).toBe(meter)
  resize({ width: 283 })
  expect(footer.contains(shield)).toBe(true)
  expect(atomicMove).toHaveBeenCalledTimes(1)
  resize({ width: 355 })
  expect(toolbar.contains(meter)).toBe(true)
  expect(toolbar.contains(shield)).toBe(true)
  expect(document.activeElement).toBe(meter)
  resize({ width: 332, withStatus: false })
  expect(toolbar.contains(meter)).toBe(true)
  expect(within(footer).queryByRole('button')).toBeNull()
  resize({ width: 280, viewport: 'expanded' })
  expect(gap()).toBe('')
  resize({ width: 283, viewport: 'medium', touch: true })
  expect(footer.contains(meter)).toBe(true)
  resize({ width: 280, viewport: 'expanded' })
  resize({ width: 0 })
  expect(gap()).toBe('')
  resize({ width: 300, touchSize: '' })
  expect(gap()).toBe('')
  resized!([], {} as ResizeObserver)
  resized!([], {} as ResizeObserver)
  expect(frames.size).toBe(1)
  view.unmount()
  expect(frames.size).toBe(0)
  vi.stubGlobal('ResizeObserver', undefined)
  const withoutObserver = render(<Toolbar width={283} />)
  expect(within(withoutObserver.getByRole('group', { name: 'Footer' })).getByRole('button', { name: 'Maintenance' })).toBeTruthy()
})

it('leaves detached and server-rendered seats unplaced', () => {
  const { result } = renderHook(() => useComposerStatusLayout({ current: null }))
  expect(result.current.context.mount?.isConnected).toBe(false)
  vi.stubGlobal('document', undefined)
  try {
    const markup = renderToString(<Toolbar width={355} />)
    expect(markup).not.toContain('Context used')
    expect(markup).not.toContain('Maintenance')
  } finally { vi.unstubAllGlobals() }
})
