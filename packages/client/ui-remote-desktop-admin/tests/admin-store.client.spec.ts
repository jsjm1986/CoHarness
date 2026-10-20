/** Remote-desktop administration controller: session resolution, list refresh, and write→refresh. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteDesktopAdminController } from '../src/client/admin-store.ts'
import type { RemoteDesktopGrantView } from '@deepseek-ai/dsh-api-remote-desktop-controller/types'
import type { ClientRemoteDesktops } from '@deepseek-ai/dsh-api-remote-desktop-controller/client'

const SESSION = 's-1' as SessionId
const GRANT: RemoteDesktopGrantView = {
  id: 'g-1', target: { nodeId: 'node-1' }, principal: 'user-1', level: 'view',
  scope: { kind: 'machine' }, recording: false, grantedBy: 'admin-1', createdAt: 1,
}

type RemoteApi = Pick<ClientRemoteDesktops, 'listGrants' | 'grant' | 'setLevel' | 'revoke' | 'audit'>

function remote(overrides: Partial<RemoteApi> = {}): RemoteApi {
  return {
    listGrants: overrides.listGrants ?? vi.fn<RemoteApi['listGrants']>().mockResolvedValue([GRANT]),
    audit: overrides.audit ?? vi.fn<RemoteApi['audit']>().mockResolvedValue([]),
    grant: vi.fn<RemoteApi['grant']>().mockResolvedValue(GRANT),
    setLevel: vi.fn<RemoteApi['setLevel']>().mockResolvedValue({ ...GRANT, level: 'control' }),
    revoke: overrides.revoke ?? vi.fn<RemoteApi['revoke']>().mockResolvedValue({ ...GRANT, revokedAt: 2 }),
  }
}

describe('remote-desktop admin controller', () => {
  it('lists grants and audit for the active session', async () => {
    const api = remote()
    const controller = new RemoteDesktopAdminController(api, () => SESSION)
    const gate = new AbortController()
    await controller.refresh(false, gate.signal)
    expect(api.listGrants).toHaveBeenCalledWith(SESSION, { includeRevoked: false }, gate.signal)
    expect(controller.store.getSnapshot().grants).toEqual([GRANT])
  })

  it('reports sessionRequired when no session is active', async () => {
    const controller = new RemoteDesktopAdminController(remote(), () => undefined)
    await controller.refresh(false, new AbortController().signal)
    expect(controller.store.getSnapshot().error).toBe('sessionRequired')
  })

  it('revokes a grant then refreshes rows', async () => {
    const api = remote()
    const controller = new RemoteDesktopAdminController(api, () => SESSION)
    const gate = new AbortController()
    await controller.revoke('g-1', gate.signal)
    expect(api.revoke).toHaveBeenCalledWith(SESSION, 'g-1', gate.signal)
    expect(api.listGrants).toHaveBeenCalled()
  })

  it('surfaces the rejection message', async () => {
    const api = remote({ listGrants: vi.fn().mockRejectedValue(new Error('denied')) })
    const controller = new RemoteDesktopAdminController(api, () => SESSION)
    await controller.refresh(false, new AbortController().signal)
    expect(controller.store.getSnapshot().error).toBe('denied')
  })
})
