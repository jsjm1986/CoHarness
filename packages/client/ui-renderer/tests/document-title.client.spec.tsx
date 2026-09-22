// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DocumentTitle } from '../src/client/DocumentTitle.tsx'

afterEach(() => {
  cleanup()
  document.title = ''
  vi.unstubAllEnvs()
})

describe('DocumentTitle', () => {
  it('projects a durable title and restores the product title', () => {
    document.title = 'stale title'
    const mounted = render(<DocumentTitle productTitle="CoHarness" />)
    expect(document.title).toBe('CoHarness')
    mounted.rerender(<DocumentTitle productTitle="CoHarness" title="First title" />)
    expect(document.title).toBe('First title — CoHarness')
    mounted.rerender(<DocumentTitle productTitle="CoHarness" title="Revised title" />)
    expect(document.title).toBe('Revised title — CoHarness')
    mounted.rerender(<DocumentTitle productTitle="CoHarness" />)
    expect(document.title).toBe('CoHarness')
    mounted.unmount()
    expect(document.title).toBe('CoHarness')
  })

  it('projects the session title bare when no product title resolves', () => {
    document.title = 'stale title'
    const mounted = render(<DocumentTitle title="First title" />)
    expect(document.title).toBe('First title')
    mounted.rerender(<DocumentTitle />)
    expect(document.title).toBe('First title')
    mounted.unmount()
    expect(document.title).toBe('First title')
  })
})
