// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { BootPage } from '../src/boot-page.ts'
import { StartupDraftView } from '../src/startup-draft.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('COHARNESS')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('keeps a focused remote draft and recovery link through late plugin status changes', () => {
    const { el, page } = mount()
    const draft = new StartupDraftView({
      language: 'en', nodeName: 'Compute', nodeId: 'c06bdb76-ae4c-42db-80d8-9d5578ccf322',
      runtimeId: '346c1bc8-a9ac-4e59-a930-4551df414a17', principalId: 3, scope: 'personal',
    })
    try {
      page.attachDraft(draft)
      const input = el.querySelector('textarea')!
      input.value = 'Unsent text'
      input.focus()
      page.setState('required', 'failed')
      page.setState('required', 'active')
      page.fail('A required entry could not activate')
      page.attachDraft(draft)
      draft.showUnavailable()
      page.setState('other', 'active')
      expect(el.querySelector('textarea')).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe('Unsent text')
      expect(el.querySelector('a')?.textContent).toBe('Open full workspace in a new tab')

      // Retaining for mount and re-attaching on mount failure removes the retained wrapper and keeps focus.
      draft.retainAtMount()
      expect(document.body.querySelector('details')).not.toBeNull()
      page.attachDraft(draft)
      expect(document.body.querySelector('details')).toBeNull()
      expect(el.querySelector('textarea')).toBe(input)
      expect(document.activeElement).toBe(input)
    } finally {
      draft.dispose()
    }
    // Re-attaching a disposed draft does not resurrect dead DOM.
    page.attachDraft(draft)
    expect(el.querySelector('[data-dsh-startup-draft]')).toBeNull()
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})
