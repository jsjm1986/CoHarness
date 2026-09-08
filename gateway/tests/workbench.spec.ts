import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { createGatewayWorkbenchCatalogHandler } from '../src/workbench.ts'
import type { GatewayCollaborationService, GatewayInstanceService } from '../src/services.ts'
import type { UserRow } from '../src/auth.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('workbench account catalog', () => {
  it('combines personal runtime roots with project metadata and releases its lease', async () => {
    const operationRef = vi.fn(async () => {})
    const instances = {
      ensureRunning: async () => ({ port: 42000, generation: 3 }),
      operationRef,
    } as unknown as GatewayInstanceService
    const collaboration = {
      listAccountConversations: async () => [{
        sessionId: 'project-root', runtime: { kind: 'project', projectId: 7, projectName: 'Demo' },
        visibility: 'project', creatorUserId: 2, creatorDisplayName: 'Alice',
        updatedAt: 5, blank: false, canWrite: false,
      }],
    } as unknown as GatewayCollaborationService
    const user: UserRow = {
      id: 1, username: 'me', displayName: 'Me', role: 'user', status: 'active',
      homePath: '/home/me', mustChangePassword: false,
    }
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({
      type: 'server-response', result: { ok: true, value: url.endsWith('/workspace.list')
        ? { items: [], archivedSessionIds: ['archived-root'] }
        : { items: [
        { sessionId: 'personal-root', updatedAt: 10, blank: false, cwd: '/home/me', projections: { values: { title: 'Personal' } } },
        { sessionId: 'child', parentSessionId: 'personal-root', updatedAt: 11, blank: false },
        { sessionId: 'archived-root', updatedAt: 12, blank: false },
      ] } },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const handler = createGatewayWorkbenchCatalogHandler({
      instances, collaboration,
      principals: new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'test', 30_000),
      maxResponseBytes: 1024 * 1024, upstreamTimeoutMs: 30_000,
    })
    const rows = await handler(user, new AbortController().signal)
    expect(rows.map(row => row.sessionId)).toEqual(['personal-root', 'project-root'])
    expect(rows[0]).toMatchObject({ title: 'Personal', runtime: { kind: 'personal' }, creatorUserId: 1 })
    expect(operationRef.mock.calls).toEqual([
      [{ kind: 'user', id: 1 }, 1, 3],
      [{ kind: 'user', id: 1 }, -1, 3],
    ])
  })
})
