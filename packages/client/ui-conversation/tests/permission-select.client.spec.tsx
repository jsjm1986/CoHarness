// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PermissionCatalog, PermissionSelection as PermissionSelectValue,
} from '@deepseek-ai/dsh-permission-presets/client'
import type { ComposerBarProps } from '../src/client/contract/slots.ts'
import { PermissionSelect } from '../src/client/skeleton/PermissionSelect.tsx'

const t: ComposerBarProps['t'] = (key, params) => {
  const values: Record<string, string> = {
    'input.accessMode': '访问模式，当前：{name}',
    'access.preset.readOnly': 'Read Only',
    'access.preset.workspaceWrite': 'Workspace Write',
    'access.preset.fullAccess': 'Full access',
    'access.confirm.title': '确认启用 Full access？',
    'access.confirm.description': 'Full access 风险确认',
    'access.confirm.acknowledge': '我已了解风险，并愿意继续',
    'access.confirm.cancel': '取消',
    'access.confirm.enable': '启用 Full access',
    'access.unavailableLabel': 'Unavailable',
    'access.currentUnavailable': '{name} is selected but unavailable for this account. Choose a standard mode.',
    'access.unavailable.unverified': 'Account eligibility is unconfirmed. Reconnect and try again.',
    'access.unavailable.admin-required': 'Full access is available to administrators only.',
    'access.unavailable.auto-ineligible': 'This account is not eligible for Auto. Choose a standard mode.',
  }
  const value = values[key] ?? key
  return params === undefined ? value : value.replace(/\{(\w+)\}/g, (_, name: string) => {
    const replacement = params[name]
    return typeof replacement === 'string' || typeof replacement === 'number'
      ? String(replacement)
      : JSON.stringify(replacement) ?? ''
  })
}

const catalog: PermissionCatalog = {
  options: [
    { value: 'read-only', name: 'read-only', description: '仅读取' },
    { value: 'workspace-write', name: 'workspace-write', description: '工作区可写' },
    { value: 'danger-full-access', name: 'danger-full-access', description: '完全访问' },
  ],
  defaultOptions: [{ value: 'read-only', name: 'read-only', description: '仅读取' }],
  defaultPreset: 'read-only',
}

const value: PermissionSelectValue = {
  currentValue: 'workspace-write',
}

afterEach(cleanup)

describe('PermissionSelect mobile presentation', () => {
  it('returns focus after cancelling confirmation and blocks duplicate commands while submitting', async () => {
    const pending = Promise.withResolvers<boolean>()
    const command = vi.fn(() => pending.promise)
    render(<PermissionSelect availability="local" value={value} catalog={catalog}
      locked={false} command={command} t={t} presentation="section" />)
    const full = screen.getByRole('menuitemradio', { name: 'Full access' })
    fireEvent.click(full)
    expect(full.hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('checkbox'))
    expect(screen.queryByRole('menuitemradio', { name: 'Read Only' })).toBeNull()
    screen.getByRole('menuitemradio', { name: 'Read Only', hidden: true }).focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(full)
    expect(command).not.toHaveBeenCalled()

    fireEvent.click(full)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '启用 Full access' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    for (const option of screen.getAllByRole('menuitemradio')) expect(option.hasAttribute('disabled')).toBe(true)
    fireEvent.click(full)
    expect(command).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenCalledWith('/permission danger-full-access')
    await act(async () => { pending.resolve(true); await pending.promise })
    expect(full.hasAttribute('disabled')).toBe(false)
  })

  it('captures the phone access trigger before opening its settings sheet', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    try {
      const onOpenSettings = vi.fn()
      render(<PermissionSelect availability="local" value={value} catalog={catalog}
        locked={false} command={vi.fn()} t={t} onOpenSettings={onOpenSettings} />)
      const trigger = screen.getByRole('button', { name: '访问模式，当前：Workspace Write' })
      fireEvent.click(trigger)
      expect(onOpenSettings).toHaveBeenCalledWith('permission')
      expect(document.activeElement).toBe(trigger)
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps selected Auto visible and explains how to leave it without silently changing the mode', () => {
    const command = vi.fn(() => Promise.resolve(true))
    render(<PermissionSelect value={{ currentValue: 'auto' }}
      catalog={{ ...catalog, options: [...catalog.options, { value: 'auto', name: 'auto' }] }}
      availability="standard" locked={false} command={command} t={t} presentation="section" />)
    expect(screen.getByRole('status').textContent).toContain('Auto is selected but unavailable')
    expect(screen.getByRole('menuitemradio', { name: /Auto/ }).getAttribute('aria-checked')).toBe('true')
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Read Only' }))
    expect(command).toHaveBeenCalledWith('/permission read-only')
  })

  it('closes a Full confirmation when current account eligibility is withdrawn', () => {
    const command = vi.fn(() => Promise.resolve(true))
    const view = render(<PermissionSelect availability="full-and-auto" value={value} catalog={catalog}
      locked={false} command={command} t={t} presentation="section" />)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Full access' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    view.rerender(<PermissionSelect availability="unknown" value={value} catalog={catalog}
      locked={false} command={command} t={t} presentation="section" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    const full = screen.getByRole('menuitemradio', { name: /Full access/ })
    expect(full).toBeInstanceOf(HTMLButtonElement)
    expect(full.getAttribute('disabled')).not.toBeNull()
    expect(command).not.toHaveBeenCalled()
  })
  it('disables Full and Auto for an account without those qualifications', () => {
    const command = vi.fn(() => Promise.resolve(true))
    render(<PermissionSelect value={value} catalog={{ ...catalog, options: [...catalog.options, { value: 'auto', name: 'auto' }] }}
      availability="standard" locked={false} command={command} t={t} presentation="section" />)
    const full = screen.getByRole('menuitemradio', { name: /Full access/ }) as HTMLButtonElement
    const auto = screen.getByRole('menuitemradio', { name: /Auto/ }) as HTMLButtonElement
    expect(full.disabled).toBe(true)
    expect(auto.disabled).toBe(true)
    fireEvent.click(auto)
    expect(command).not.toHaveBeenCalled()
  })
  it('names the current permission on the compact icon trigger', () => {
    render(<PermissionSelect availability="local" value={value} catalog={catalog} locked={false} command={vi.fn()} t={t} />)
    // The icon-only trigger keeps the mode on its accessible name; the label
    // span stays in the DOM for the desktop tier and is hidden by compact CSS.
    const trigger = screen.getByRole('button', { name: '访问模式，当前：Workspace Write' })
    expect(trigger.textContent).toContain('Workspace Write')
  })

  it('renders section options and submits the current-session command', async () => {
    const command = vi.fn(() => Promise.resolve(true))
    render(<PermissionSelect availability="local" value={value} catalog={catalog} locked={false} command={command} t={t} presentation="section" />)
    expect(screen.getByRole('menuitemradio', { name: 'Read Only' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /Workspace Write/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Read Only' }))
    expect(command).toHaveBeenCalledWith('/permission read-only')
  })
})
