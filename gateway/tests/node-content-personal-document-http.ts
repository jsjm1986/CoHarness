/** Authenticated personal-document migration through a loopback Gateway backed by the fixture's two physical databases. */
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { expect } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import type { GatewayConfig } from '../src/config.ts'
import { InstanceManager } from '../src/instances.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import type { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'

/** Open two genuine browser sessions on the HTTP entry that owns the account's files. */
export async function personalDocumentAdminHttp(
  context: PostgresRuntimeContext,
  cfg: GatewayConfig,
  documents: PostgresDocumentCatalogService,
  user: number,
) {
  const users = new PostgresUserService(context, cfg)
  const instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
  const deps: GatewayDeps = {
    cfg,
    users,
    instances,
    documents,
    projects: new PostgresProjectService(context, cfg),
    auth: new PostgresAuthService(context, cfg),
    audit: new PostgresAuditService(context),
    nodeServiceIdentity: {
      nodeId: context.nodeId as RuntimeNodeId,
      organizationId: context.organizationId,
      async authorize() {
        throw new Error('This fixture accepts only browser sessions.')
      },
    },
  }
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise<void>((ready, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', ready)
  })
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  cfg.publicOrigins.push(base)
  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
    await instances.stopAll()
  }
  try {
    const login = async (role: 'admin' | 'user') => {
      const username = 'doc-' + randomUUID().slice(0, 12),
        password = randomUUID()
      const account = await users.create({ username, password, role })
      await users.changeOwnPassword(account.id, password)
      const result = await fetch(base + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password }),
      })
      const cookie = result.headers.getSetCookie()[0]?.split(';')[0]
      await result.arrayBuffer()
      if (result.status !== 302 || !cookie) throw new Error('The document migration fixture could not authenticate.')
      return cookie
    }
    const admin = await login('admin'),
      member = await login('user')
    const endpoint = base + '/admin/api/documents/personal/' + user + '/migration'
    return {
      close,
      async request(query: string, form?: unknown, ordinary = false) {
        const url = endpoint + '?' + query
        const response = await fetch(url, {
          method: form === undefined ? 'GET' : 'POST',
          redirect: 'manual',
          headers: { cookie: ordinary ? member : admin, origin: base, 'content-type': 'application/json' },
          body: form === undefined ? undefined : JSON.stringify(form),
          signal: AbortSignal.timeout(15000),
        })
        const text = await response.text()
        if (response.ok) expect(response.headers.get('cache-control')).toContain('no-store')
        return {
          status: response.status,
          value: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
