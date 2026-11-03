// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectManagerModal } from '../src/client/ProjectManagerModal.tsx'
import { CollaborationRequestError, type ProjectInvitation } from '../src/client/collaboration-client.ts'
import { zh, type CollaborationKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: CollaborationKey): string => zh[key]

const incoming: ProjectInvitation = { id: 'incoming-b', projectId: 19, projectName: '另一台电脑的项目',
  inviter: { id: 8, username: 'zhou', displayName: '周工' }, invitee: { id: 7, username: 'lin', displayName: '林工' },
  mode: 'ro', status: 'pending', createdAt: '2026-10-31T00:00:00.000Z', expiresAt: null, respondedAt: null }

it('accepts an incoming invitation while viewing another read-only project without requesting its member directory', async () => {
  let accepted = false
  const listInvitations = vi.fn(async (projectId?: number) => projectId === undefined && !accepted ? [incoming] : [])
  const listUsers = vi.fn(async () => [])
  const acceptInvitation = vi.fn(async () => { accepted = true })
  const onCreated = vi.fn()
  render(<ProjectManagerModal open mode="members" projectId={9} currentUserId={7} t={t}
    listInvitations={listInvitations} listUsers={listUsers} acceptInvitation={acceptInvitation}
    onCreated={onCreated} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: t('manager.accept') }))
  await waitFor(() => expect(screen.queryByText(incoming.projectName)).toBeNull())
  expect(acceptInvitation).toHaveBeenCalledExactlyOnceWith(incoming.id)
  expect(listInvitations.mock.calls).toEqual([[], []])
  expect(listUsers).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps personal incoming invitations alongside deduplicated project invitations for a project manager', async () => {
  const outgoing: ProjectInvitation = { ...incoming, id: 'outgoing-a', projectId: 9, projectName: '当前项目',
    invitee: { id: 12, username: 'chen', displayName: '陈工' }, inviter: incoming.invitee }
  const listInvitations = vi.fn(async (projectId?: number) => projectId === undefined ? [incoming] : [incoming, outgoing])
  render(<ProjectManagerModal open mode="members" projectId={9} canManage currentUserId={7} t={t}
    listInvitations={listInvitations} onCreated={vi.fn()} onClose={vi.fn()} />)
  expect(await screen.findByText(incoming.projectName)).toBeTruthy()
  expect(await screen.findByText(outgoing.projectName)).toBeTruthy()
  expect(screen.getAllByRole('button', { name: t('manager.accept') })).toHaveLength(1)
  expect(listInvitations.mock.calls).toEqual([[], [9]])
})

it('retains incoming invitations when reading the managed project invitations fails', async () => {
  const listInvitations = vi.fn(async (projectId?: number) => {
    if (projectId !== undefined) throw new CollaborationRequestError(403, 'invitation-forbidden')
    return [incoming]
  })
  render(<ProjectManagerModal open mode="members" projectId={9} canManage currentUserId={7} t={t}
    listInvitations={listInvitations} onCreated={vi.fn()} onClose={vi.fn()} />)
  expect(await screen.findByText(incoming.projectName)).toBeTruthy()
  expect((await screen.findByRole('alert')).textContent).toBe(t('manager.invitationForbidden'))
  expect(screen.getByRole('button', { name: t('manager.accept') })).toBeTruthy()
})

it('retains the selected recipient and explains missing computer permission when issuing an invitation', async () => {
  const inviteMember = vi.fn().mockRejectedValue(new CollaborationRequestError(403, 'invitation-computer-required'))
  render(<ProjectManagerModal open mode="members" projectId={9} canManage currentUserId={7} t={t}
    initialView="compose" listInvitations={async () => []} listUsers={async () => [{ id: 8, username: 'zhou', displayName: '周工' }]}
    inviteMember={inviteMember} onCreated={vi.fn()} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByLabelText(/选择成员 选择要邀请的成员/))
  fireEvent.click(await screen.findByRole('menuitem', { name: /周工/ }))
  fireEvent.click(screen.getByRole('button', { name: t('manager.invite') }))
  expect((await screen.findByRole('alert')).textContent).toBe(t('manager.computerRequired'))
  expect(screen.getByLabelText(/选择成员 周工/).textContent).toContain('周工')
  expect(inviteMember).toHaveBeenCalledWith(9, 'zhou', 'rw')
})

it('keeps a refused invitation available after its computer permission is revoked', async () => {
  const invitation: ProjectInvitation = { id: 'invitation-b', projectId: 9, projectName: '支付重构',
    inviter: { id: 8, username: 'zhou', displayName: '周工' }, invitee: { id: 7, username: 'lin', displayName: '林工' },
    mode: 'rw', status: 'pending', createdAt: '2026-10-30T00:00:00.000Z', expiresAt: null, respondedAt: null }
  const acceptInvitation = vi.fn().mockRejectedValue(new CollaborationRequestError(403, 'invitation-computer-required'))
  const listInvitations = vi.fn().mockResolvedValue([invitation])
  render(<ProjectManagerModal open mode="members" currentUserId={7} t={t} listInvitations={listInvitations}
    acceptInvitation={acceptInvitation} onCreated={vi.fn()} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: t('manager.accept') }))
  expect((await screen.findByRole('alert')).textContent).toBe(t('manager.computerRequired'))
  expect(screen.getByText('支付重构')).toBeTruthy()
  expect(screen.getByRole('button', { name: t('manager.accept') }).hasAttribute('disabled')).toBe(false)
  expect(listInvitations).toHaveBeenCalledOnce()
})


it('creates a project on the selected authorized computer and leaves unavailable computers disabled', async () => {
  const createProject = vi.fn(async () => 19), created = vi.fn()
  render(<ProjectManagerModal open mode="create" currentUserId={7} t={t}
    listComputers={async () => [{ nodeId: 'a' as never, name: '办公电脑', status: 'active' },
      { nodeId: 'b' as never, name: '计算电脑', status: 'active' }, { nodeId: 'offline' as never, name: '离线电脑', status: 'offline' }]}
    initialNodeId="a" createProject={createProject} onCreated={created} onClose={vi.fn()} />)
  await screen.findByRole('option', { name: '计算电脑' })
  const computer = screen.getByLabelText(t('manager.computerLabel')) as HTMLSelectElement
  expect(computer.value).toBe('a')
  expect((computer.options[computer.options.length - 1] as HTMLOptionElement).disabled).toBe(true)
  fireEvent.change(computer, { target: { value: 'b' } })
  fireEvent.change(screen.getByLabelText(t('manager.nameLabel')), { target: { value: '发布准备' } })
  fireEvent.click(screen.getByRole('button', { name: t('manager.create') }))
  await screen.findByRole('button', { name: t('manager.create') })
  expect(createProject).toHaveBeenCalledExactlyOnceWith('发布准备', 'b')
  expect(created).toHaveBeenCalledExactlyOnceWith(19)
})

it('retains an open project name and refuses its remote computer after this entry becomes local', async () => {
  const createProject = vi.fn(async () => 19)
  const listComputers = vi.fn(async () => [{ nodeId: 'a' as never, name: '办公电脑', status: 'active' as const },
    { nodeId: 'b' as never, name: '计算电脑', status: 'active' as const }])
  const props = { open: true, mode: 'create' as const, currentUserId: 7, t, initialNodeId: 'a', createProject,
    onCreated: vi.fn(), onClose: vi.fn() }
  const view = render(<ProjectManagerModal {...props} listComputers={listComputers} />)
  await screen.findByRole('option', { name: '计算电脑' })
  fireEvent.change(screen.getByLabelText(t('manager.computerLabel')), { target: { value: 'b' } })
  fireEvent.change(screen.getByLabelText(t('manager.nameLabel')), { target: { value: '尚未创建的项目' } })
  view.rerender(<ProjectManagerModal {...props} allowedNodeId={'a' as never} />)
  expect(screen.getByRole('alert').textContent).toBe(t('manager.targetUnavailable'))
  expect(screen.getByLabelText(t('manager.nameLabel'))).toHaveProperty('value', '尚未创建的项目')
  const create = screen.getByRole('button', { name: t('manager.create') })
  expect(create).toHaveProperty('disabled', true)
  fireEvent.submit(screen.getByLabelText(t('manager.nameLabel')).closest('form')!)
  expect(createProject).not.toHaveBeenCalled()
  view.rerender(<ProjectManagerModal {...props} open={false} allowedNodeId={'a' as never} />)
  view.rerender(<ProjectManagerModal {...props} allowedNodeId={'a' as never} />)
  fireEvent.change(screen.getByLabelText(t('manager.nameLabel')), { target: { value: '本机新项目' } })
  expect(screen.queryByLabelText(t('manager.computerLabel'))).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('manager.create') }))
  expect(createProject).toHaveBeenCalledExactlyOnceWith('本机新项目', undefined)
  await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(19))
})
