import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { SshPage } from './SshPage.tsx'

vi.mock('../api.ts', () => ({
  createSshTarget: vi.fn(), listProjects: vi.fn(), listSshTargets: vi.fn(),
  mutateSshTarget: vi.fn(), shareSshTarget: vi.fn(), updateSshTarget: vi.fn(),
  listUsers: vi.fn(), getSshPolicy: vi.fn(), setSshPolicy: vi.fn(),
}))

const target = {
  publicId: 1, name: 'Test SSH', host: 'test-host', node: '/usr/bin/node',
  helper: '/opt/helper.mjs', helperHash: '0'.repeat(64), workspace: '/work',
  bootstrapPath: null, bootstrapHash: null, passwordRef: 'SSH_TEST_PASSWORD',
  requestTimeoutMs: null, maxFrameBytes: null, maxPending: null, leaseMs: null,
  enabled: true, revision: '3', sharedProjects: [],
}

async function editor() {
  render(<SshPage />)
  await screen.findByText('Test SSH')
  await userEvent.click(screen.getByRole('button', { name: '编辑' }))
  return within(screen.getByRole('dialog', { name: '编辑 Test SSH' }))
}

describe('SSH connection editing', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listSshTargets).mockResolvedValue({ targets: [target] })
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.listUsers).mockResolvedValue([])
    vi.mocked(api.updateSshTarget).mockResolvedValue(target)
  })

  it('preserves the stored password reference while editing only the display name', async () => {
    const dialog = await editor()
    fireEvent.change(dialog.getByLabelText(/^名称/), { target: { value: 'Renamed SSH' } })
    await userEvent.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.updateSshTarget).toHaveBeenCalledWith(1, '3', expect.objectContaining({
      name: 'Renamed SSH', passwordRef: 'SSH_TEST_PASSWORD',
    })))
  })

  it('removes the password reference only when the operator clears that field', async () => {
    const dialog = await editor()
    const input = dialog.getByLabelText(/^密码凭据引用/)
    expect((input as HTMLInputElement).value).toBe('SSH_TEST_PASSWORD')
    fireEvent.change(input, { target: { value: '' } })
    await userEvent.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.updateSshTarget).toHaveBeenCalledWith(1, '3', expect.objectContaining({ passwordRef: null })))
  })

  it('shows an invalid reference error inside the open editor without submitting', async () => {
    const dialog = await editor()
    fireEvent.change(dialog.getByLabelText(/^密码凭据引用/), { target: { value: 'invalid-reference' } })
    await userEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect((await dialog.findByRole('alert')).textContent).toContain('密码凭据引用')
    expect(api.updateSshTarget).not.toHaveBeenCalled()
  })
})
