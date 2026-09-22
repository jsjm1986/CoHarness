// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
}

const value: PermissionSelectValue = {
  currentValue: 'workspace-write',
}

afterEach(cleanup)

describe('PermissionSelect mobile presentation', () => {
  it('names the current permission on the compact icon trigger', () => {
    render(<PermissionSelect value={value} catalog={catalog} locked={false} command={vi.fn()} t={t} />)
    // The icon-only trigger keeps the mode on its accessible name; the label
    // span stays in the DOM for the desktop tier and is hidden by compact CSS.
    const trigger = screen.getByRole('button', { name: '访问模式，当前：Workspace Write' })
    expect(trigger.textContent).toContain('Workspace Write')
  })

  it('renders section options and submits the current-session command', async () => {
    const command = vi.fn(() => Promise.resolve(true))
    render(<PermissionSelect value={value} catalog={catalog} locked={false} command={command} t={t} presentation="section" />)
    expect(screen.getByRole('menuitemradio', { name: 'Read Only' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /Workspace Write/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Read Only' }))
    expect(command).toHaveBeenCalledWith('/permission read-only')
  })
})
