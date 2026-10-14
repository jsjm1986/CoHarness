// @vitest-environment jsdom
/**
 * Gesture contract for `useSheetSwipeDismiss`: a downward pan on a compact
 * bottom sheet tracks the finger and fades the scrim, a release past the
 * distance or velocity threshold dismisses, a short release snaps back, and
 * the drag yields to any scrollable ancestry that is not pinned at its top.
 * jsdom has no layout or TouchEvent constructor; touches are faked onto plain
 * cancelable Events and geometry comes from defineProperty stubs.
 */
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSheetSwipeDismiss } from '../src/useSheetSwipeDismiss.ts'

let now: number
beforeEach(() => {
  now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 767px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Sheet({ active = true, onDismiss = () => {}, scrim = true, children }: {
  active?: boolean
  onDismiss?: () => void
  scrim?: boolean
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useSheetSwipeDismiss(ref, active, onDismiss)
  return <div>
    {scrim ? <div data-testid="scrim" /> : null}
    <div ref={ref} data-testid="sheet">{children}</div>
  </div>
}

function mount(props: Parameters<typeof Sheet>[0] = {}) {
  const view = render(<Sheet {...props} />)
  const sheet = view.getByTestId('sheet')
  const scrim = view.queryByTestId('scrim')
  return { view, sheet, scrim }
}

function fireTouch(target: EventTarget, type: string, point?: { clientX: number; clientY: number }) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: point === undefined ? [] : [point] })
  act(() => { target.dispatchEvent(event) })
  return event
}

const down = (target: EventTarget, x = 0, y = 100) => fireTouch(target, 'touchstart', { clientX: x, clientY: y })
const move = (target: EventTarget, x = 0, y = 100) => fireTouch(target, 'touchmove', { clientX: x, clientY: y })
const up = (target: EventTarget, type = 'touchend') => fireTouch(target, type)

describe('useSheetSwipeDismiss', () => {
  it('tracks the finger, fades the scrim, and dismisses past the distance threshold', () => {
    const onDismiss = vi.fn()
    const { sheet, scrim } = mount({ onDismiss })
    down(sheet)
    move(sheet, 0, 140)
    const moving = move(sheet, 0, 240)
    expect(moving.defaultPrevented).toBe(true)
    expect(sheet.style.transform).toBe('translateY(140px)')
    expect(scrim?.style.opacity).toBe('0')
    up(sheet)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('dismisses on a short flick faster than the velocity threshold', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss })
    down(sheet)
    move(sheet, 0, 140)
    now += 50
    up(sheet)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('snaps a short, slow release back to rest', () => {
    const onDismiss = vi.fn()
    const { sheet, scrim } = mount({ onDismiss })
    down(sheet)
    move(sheet, 0, 140)
    now += 500
    up(sheet)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(sheet.style.transform).toBe('')
    expect(sheet.style.transition).toContain('transform')
    expect(scrim?.style.opacity).toBe('')
  })

  it('ignores a pan that commits horizontal or upward', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss })
    down(sheet)
    move(sheet, 40, 100)
    move(sheet, 80, 260)
    expect(sheet.style.transform).toBe('')
    down(sheet)
    move(sheet, 0, 60)
    move(sheet, 0, 20)
    expect(sheet.style.transform).toBe('')
    up(sheet)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('keeps waiting through sub-threshold moves before engaging', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss })
    down(sheet)
    move(sheet, 0, 105)
    move(sheet, 0, 108)
    move(sheet, 0, 220)
    expect(sheet.style.transform).toBe('translateY(120px)')
    up(sheet)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('yields the drag to a scrolled region in the touch ancestry', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss, children: <div data-testid="body" /> })
    const body = sheet.firstElementChild as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { value: 400, configurable: true })
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(body, 'scrollTop', { value: 30, configurable: true })
    down(body)
    move(body, 0, 200)
    move(body, 0, 260)
    expect(sheet.style.transform).toBe('')
    up(body)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('claims the pan when the scrollable ancestry is pinned at its top', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss, children: <div data-testid="body" /> })
    const body = sheet.firstElementChild as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { value: 400, configurable: true })
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true })
    down(body)
    move(body, 0, 250)
    expect(sheet.style.transform).toBe('translateY(150px)')
    up(body)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('treats a scrolled sheet itself as scrollable ancestry', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss })
    Object.defineProperty(sheet, 'scrollHeight', { value: 400, configurable: true })
    Object.defineProperty(sheet, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(sheet, 'scrollTop', { value: 10, configurable: true })
    down(sheet)
    move(sheet, 0, 200)
    expect(sheet.style.transform).toBe('')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('treats a non-element touch target as having no scrollable ancestry', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss, children: 'label' })
    const text = sheet.firstChild!
    down(text)
    move(text, 0, 250)
    expect(sheet.style.transform).toBe('translateY(150px)')
    up(text)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('ignores contact-less touches, unstarted moves, and unfinished releases', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss })
    move(sheet, 0, 200)
    up(sheet)
    fireTouch(sheet, 'touchstart')
    move(sheet, 0, 200)
    down(sheet)
    fireTouch(sheet, 'touchmove')
    up(sheet)
    expect(sheet.style.transform).toBe('')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('cancels an engaged drag without dismissing when the release is small', () => {
    const onDismiss = vi.fn()
    const { sheet } = mount({ onDismiss })
    down(sheet)
    move(sheet, 0, 130)
    now += 500
    up(sheet, 'touchcancel')
    expect(onDismiss).not.toHaveBeenCalled()
    expect(sheet.style.transform).toBe('')
  })

  it('stays inert off sheet widths, while inactive, and without a scrim sibling', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} }))
    const wide = mount()
    down(wide.sheet)
    move(wide.sheet, 0, 250)
    expect(wide.sheet.style.transform).toBe('')
    wide.view.unmount()

    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const inactive = mount({ active: false })
    down(inactive.sheet)
    move(inactive.sheet, 0, 250)
    expect(inactive.sheet.style.transform).toBe('')
    inactive.view.unmount()

    const bare = mount({ scrim: false })
    down(bare.sheet)
    move(bare.sheet, 0, 130)
    expect(bare.sheet.style.transform).toBe('translateY(30px)')
    now += 500
    up(bare.sheet)
    expect(bare.sheet.style.transform).toBe('')
  })

  it('releases the sheet styling when the component unmounts mid-drag', () => {
    const onDismiss = vi.fn()
    const { view, sheet, scrim } = mount({ onDismiss })
    down(sheet)
    move(sheet, 0, 200)
    view.unmount()
    expect(sheet.style.transform).toBe('')
    expect(sheet.style.transition).toBe('')
    expect(scrim?.style.opacity).toBe('')
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
