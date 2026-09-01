// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useRef, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { useViewportHighlighting } from '../src/markdown/useViewportHighlighting.ts'

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []
  readonly observed = new Set<Element>()
  readonly unobserved = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void { this.observed.add(element) }
  unobserve(element: Element): void { this.observed.delete(element); this.unobserved.add(element) }
  disconnect(): void { this.disconnected = true; this.observed.clear() }
  takeRecords(): IntersectionObserverEntry[] { return [] }

  intersect(element: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

function NullTarget(): ReactElement {
  const target = useRef<Element>(null)
  const active = useViewportHighlighting(target, 'ts')
  return <span data-active={String(active)} />
}

beforeEach(() => {
  IntersectionObserverStub.instances = []
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('viewport-activated syntax highlighting', () => {
  it('keeps pending blocks plain and permanently activates intersecting blocks', async () => {
    const view = render(
      <>
        <CodeBlock code="const first = 1" lang="ts" />
        <CodeBlock code="const second = 2" lang="ts" />
      </>,
    )
    const blocks = [...view.container.querySelectorAll('.md-code-block')]
    const observer = IntersectionObserverStub.instances[0]
    if (observer === undefined) throw new Error('expected a shared viewport observer')
    expect(observer.observed.size).toBe(2)
    expect(view.container.querySelectorAll('pre.shiki')).toHaveLength(0)

    act(() => { observer.intersect(blocks[0]!, true) })
    await waitFor(() => { expect(blocks[0]!.querySelector('pre.shiki')).not.toBeNull() })
    expect(blocks[1]!.querySelector('pre.shiki')).toBeNull()
    expect(observer.unobserved.has(blocks[0]!)).toBe(true)

    act(() => { observer.intersect(blocks[0]!, false) })
    expect(blocks[0]!.querySelector('pre.shiki')).not.toBeNull()
    act(() => { observer.intersect(blocks[0]!, true) })
  })

  it('does not observe unsupported languages', () => {
    const view = render(<CodeBlock code="plain" lang="cobol" />)
    expect(IntersectionObserverStub.instances).toHaveLength(0)
    expect(view.container.querySelector('pre.shiki')).toBeNull()
  })

  it('activates immediately when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const view = render(<CodeBlock code="const ready = true" lang="ts" />)
    expect(view.container.querySelector('pre.shiki')).not.toBeNull()
  })

  it('waits when a supported target ref is not attached yet', () => {
    const view = render(<NullTarget />)
    expect(view.container.querySelector('[data-active="false"]')).not.toBeNull()
    expect(IntersectionObserverStub.instances).toHaveLength(0)
  })
})
