// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectManagerModal, type ProjectManagerModalProps } from '../src/client/ProjectManagerModal.tsx'
import { ProjectSettingsModal, type ProjectSettingsModalProps } from '../src/client/ProjectSettingsModal.tsx'
import type { ProjectConfiguration, ProjectInvitation } from '../src/client/collaboration-client.ts'
import { zh, type CollaborationKey } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function t(key: CollaborationKey, params?: Record<string, string | number>): string {
  let value: string = zh[key]
  for (const [key, replacement] of Object.entries(params ?? {})) value = value.replace(`{${key}}`, String(replacement))
  return value
}
const configuration: ProjectConfiguration = {
  project: { id: 9, name: '业务空间', origin: 'admin', owner: null, themePolicy: 'follow-user' },
  canManage: true,
  capabilities: { themePolicy: true, runtimeSettings: true, projectModels: true, members: true, sshTargets: true, filesystem: false },
}
function settingsProps(overrides: Partial<ProjectSettingsModalProps> = {}): ProjectSettingsModalProps {
  return { open: true, project: { projectId: 9, name: '业务空间', path: '/private/server', mode: 'rw', canManage: true },
    t, load: vi.fn().mockResolvedValue(configuration), setThemePolicy: vi.fn(), onMembers: vi.fn(), onClose: vi.fn(), ...overrides }
}
const incoming: ProjectInvitation = {
  id: 'incoming', projectId: 9, projectName: '业务空间',
  invitee: { id: 7, username: 'lin', displayName: '林工' }, inviter: { id: 8, username: 'zhou', displayName: '周工' },
  mode: 'rw', status: 'pending', createdAt: '2026-10-01T00:00:00Z', expiresAt: null, respondedAt: null,
}
const outgoing: ProjectInvitation = { ...incoming, id: 'outgoing', invitee: incoming.inviter, inviter: incoming.invitee }
function managerProps(overrides: Partial<ProjectManagerModalProps> = {}): ProjectManagerModalProps {
  return { open: true, mode: 'members', projectId: 9, projectName: '业务空间', canManage: true, currentUserId: 7, t,
    listInvitations: vi.fn().mockResolvedValue([incoming]), listUsers: vi.fn().mockResolvedValue([
      { id: 7, username: 'lin', displayName: '林工' }, { id: 8, username: 'zhou', displayName: '周工' },
    ]), inviteMember: vi.fn().mockResolvedValue(outgoing), onCreated: vi.fn(), onClose: vi.fn(), ...overrides }
}

describe('project configuration navigation', () => {
  it('uses authoritative capabilities independently from write membership and project origin', async () => {
    const props = settingsProps({ load: vi.fn().mockResolvedValue({ ...configuration, canManage: false }) })
    render(<ProjectSettingsModal {...props} />)
    expect(await screen.findByText('可编辑对话 · 配置仅查看')).toBeTruthy()
    expect(screen.getByText('组织管理员')).toBeTruthy()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: '界面主题' }))
    expect((screen.getByRole<HTMLInputElement>('radio', { name: /浅色/ })).disabled).toBe(true)
    expect(screen.getByText('只有项目 owner 或组织管理员可以修改项目策略。')).toBeTruthy()
    expect(props.setThemePolicy).not.toHaveBeenCalled()
    expect(screen.queryByText('/private/server')).toBeNull()
  })

  it('shows a frontend creator as owner even for an administrator account', async () => {
    const owner = { id: 7, username: 'lin', displayName: '林工' }
    render(<ProjectSettingsModal {...settingsProps({ load: vi.fn().mockResolvedValue({
      ...configuration, project: { ...configuration.project, origin: 'user', owner },
    }) })} />)
    expect(await screen.findByText('用户创建')).toBeTruthy()
    expect(screen.getByText('林工')).toBeTruthy()
    expect(screen.queryByText('组织管理员')).toBeNull()
  })

  it('keeps the old theme on save failure and retries the same project operation', async () => {
    const setThemePolicy = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      ...configuration, project: { ...configuration.project, themePolicy: 'dark' },
    })
    render(<ProjectSettingsModal {...settingsProps({ setThemePolicy })} />)
    await screen.findByText('可管理项目配置')
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: '界面主题' }))
    const dark = screen.getByRole<HTMLInputElement>('radio', { name: /深色/ })
    fireEvent.click(dark)
    await screen.findByRole('alert')
    expect((screen.getByRole<HTMLInputElement>('radio', { name: /跟随/ })).checked).toBe(true)
    fireEvent.click(dark)
    await waitFor(() => { expect((dark).checked).toBe(true) })
    expect(setThemePolicy.mock.calls).toEqual([[9, 'dark'], [9, 'dark']])
  })

  it('does not request SSH targets before configuration grants the capability', async () => {
    const listSshTargets = vi.fn().mockResolvedValue([])
    const props = settingsProps({ load: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      ...configuration, canManage: false,
    }), listSshTargets, shareSshTarget: vi.fn() })
    render(<ProjectSettingsModal {...props} />)
    await screen.findByRole('alert')
    expect(listSshTargets).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: '重试' }))
    await screen.findByText('可编辑对话 · 配置仅查看')
    expect(listSshTargets).not.toHaveBeenCalled()
  })

  it('keeps SSH target identity and boolean share payloads', async () => {
    const shareSshTarget = vi.fn().mockResolvedValue({ publicId: 43, name: '生产目标', shared: true })
    render(<ProjectSettingsModal {...settingsProps({ shareSshTarget, listSshTargets: vi.fn().mockResolvedValue([
      { publicId: 43, name: '生产目标', host: 'example.test', workspace: '/workspace', enabled: true, shared: false },
    ]) })} />)
    await screen.findByText('可管理项目配置')
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'SSH 执行目标' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /生产目标/ }))
    await waitFor(() => { expect(shareSshTarget).toHaveBeenCalledWith(9, 43, true) })
  })

  it('returns from a phone detail to its overview link without closing the dialog', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width'), media: query,
      onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      dispatchEvent: vi.fn() })))
    const props = settingsProps()
    render(<ProjectSettingsModal {...props} />)
    await screen.findByText('可管理项目配置')
    const overviewLink = screen.getByRole<HTMLButtonElement>('button', { name: /界面主题.*项目/ })
    fireEvent.click(overviewLink)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '返回项目概览' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole<HTMLButtonElement>('button', { name: /界面主题.*项目/ }))
    expect(screen.getByRole('dialog', { name: '项目配置' })).toBeTruthy()
  })
})

describe('project invitation views', () => {
  it('separates recipient invitations from visible sent records and accepts without switching scope', async () => {
    const acceptInvitation = vi.fn().mockResolvedValue(undefined)
    const listInvitations = vi.fn().mockResolvedValue([incoming, outgoing])
    render(<ProjectManagerModal {...managerProps({ acceptInvitation, listInvitations })} />)
    fireEvent.click(await screen.findByRole<HTMLButtonElement>('button', { name: '接受' }))
    await waitFor(() => { expect(acceptInvitation).toHaveBeenCalledWith('incoming') })
    expect(listInvitations).toHaveBeenLastCalledWith(9)
    fireEvent.click(screen.getByRole('tab', { name: '发出的邀请' }))
    expect(screen.queryByRole('button', { name: '接受' })).toBeNull()
    expect(screen.getByText('周工')).toBeTruthy()
    expect(screen.getByText('等待接受')).toBeTruthy()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: '全部可见' }))
    await waitFor(() => { expect(listInvitations).toHaveBeenLastCalledWith(undefined) })
  })

  it('preserves selected user and access mode on failed send, then uses the original mutation', async () => {
    const inviteMember = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(outgoing)
    render(<ProjectManagerModal {...managerProps({ inviteMember, initialView: 'compose' })} />)
    const picker = await screen.findByRole<HTMLButtonElement>('button', { name: /选择成员/ })
    await waitFor(() => { expect((picker).disabled).toBe(false) })
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('menuitem', { name: /周工/ }))
    fireEvent.click(screen.getByRole<HTMLInputElement>('radio', { name: /只读/ }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: '发送邀请' }))
    await screen.findByRole('alert')
    expect((screen.getByRole<HTMLInputElement>('radio', { name: /只读/ })).checked).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /选择成员 周工/ })).toBeTruthy()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: '发送邀请' }))
    await screen.findByRole('dialog', { name: '邀请中心' })
    expect(inviteMember.mock.calls).toEqual([[9, 'zhou', 'ro'], [9, 'zhou', 'ro']])
    expect(screen.getByRole('tab', { name: '发出的邀请' }).getAttribute('aria-selected')).toBe('true')
  })

  it('keeps the form without forcing input focus, and trims only the existing create argument', async () => {
    const createProject = vi.fn().mockResolvedValue(20)
    const props = managerProps({ mode: 'create', createProject })
    render(<ProjectManagerModal {...props} />)
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: '项目名称' })
    expect(document.activeElement).not.toBe(name)
    fireEvent.change(name, { target: { value: '  新业务空间  ' } })
    fireEvent.submit(name.closest('form')!)
    await waitFor(() => { expect(props.onCreated).toHaveBeenCalledWith(20) })
    expect(createProject).toHaveBeenCalledWith('新业务空间')
  })

  it('shows a retryable read failure without losing same-scope records', async () => {
    const listInvitations = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([incoming])
    render(<ProjectManagerModal {...managerProps({ listInvitations })} />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: '重试' }))
    await screen.findByText('业务空间', { selector: 'strong' })
    expect(listInvitations.mock.calls).toEqual([[9], [9]])
  })

  it('explains maintenance qualification and keeps ordinary invitations unavailable', async () => {
    const props = managerProps({ steward: true })
    render(<ProjectManagerModal {...props} />)
    await act(async () => {})
    expect(screen.getByText('维护空间使用专门资格授权，不能通过普通项目邀请加入')).toBeTruthy()
    expect((screen.getByRole<HTMLButtonElement>('button', { name: '邀请成员' })).disabled).toBe(true)
    expect(props.listUsers).not.toHaveBeenCalled()
    expect(props.inviteMember).not.toHaveBeenCalled()
  })
})
