/** Environment selection never dispatches a foreign placement through the local adapter. */
import { expect, it, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import type { RuntimeCatalogEntry, RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import { RuntimeCatalogError } from '../src/runtime-catalog.ts'

const user: UserRow = { id: 1, username: 'alice', displayName: 'Alice', role: 'user', status: 'active',
  homePath: '/parser-only/alice', mustChangePassword: false, autoReviewEligible: false }
const nodeId = '61f22202-1c02-4a3c-8d34-f11222333444' as RuntimeNodeId
const entry: RuntimeCatalogEntry = { id: '10111111-1111-4111-8111-111111111111' as RuntimeId,
  owner: { kind: 'personal', id: 1, name: 'Alice' }, node: { id: nodeId, name: 'Center', status: 'active', lastHeartbeatAt: null },
  routing: 'local', observedState: 'stopped', generation: 1 }

function fixture(environment = entry) {
  const getById = vi.fn().mockResolvedValue(null)
  const projectForUser = vi.fn().mockResolvedValue(null)
  const catalog = { resolveForAccount: vi.fn().mockResolvedValue(environment), resolveForLanding: vi.fn().mockResolvedValue(environment),
    resolveForOwner: vi.fn(async (_actor: UserRow, owner: { kind: 'personal' | 'project'; id: number }) => {
      if (owner.kind !== environment.owner.kind || owner.id !== environment.owner.id) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
      return environment
    }) }
  const services = { projects: { getById }, collaboration: { projectForUser } }
  const adapter = new LocalRuntimeAdapter(services)
  return { catalog, getById, projectForUser, router: new GatewayRuntimeRouter(adapter, { catalog, localNodeId: nodeId }), adapter }
}

it('propagates the exact authorized environment and ignores a legacy project cookie', async () => {
  const f = fixture()
  expect(await f.router.resolve(user, { runtimeId: entry.id, target: null, scopeCookie: 'project:20' })).toEqual({
    context: { user, scope: { kind: 'personal' }, runtime: { ...user, runtimeId: entry.id }, environment: { id: entry.id, nodeId, nodeName: 'Center' } }, resetScope: false,
  })
  expect(f.catalog.resolveForAccount).toHaveBeenCalledExactlyOnceWith(user, entry.id)
  expect(f.projectForUser).not.toHaveBeenCalled()
})

it('refuses a conflicting explicit target without resolving local project paths', async () => {
  const f = fixture()
  await expect(f.router.resolve(user, { runtimeId: entry.id, target: 'project:20', scopeCookie: undefined }))
    .rejects.toMatchObject({ code: 'runtime-catalog/target-mismatch', status: 400 })
  expect(f.getById).not.toHaveBeenCalled()
})

it('uses actual node identity rather than a directory availability label before local dispatch', async () => {
  const f = fixture({ ...entry, node: { ...entry.node, id: '20222222-2222-4222-8222-222222222222' as RuntimeNodeId } })
  await expect(f.router.resolve(user, { runtimeId: entry.id, target: null, scopeCookie: 'personal' }))
    .rejects.toMatchObject({ code: 'runtime-catalog/remote-unavailable', status: 503 })
  expect(f.projectForUser).not.toHaveBeenCalled()
  expect(f.getById).not.toHaveBeenCalled()
})

it('does not infer local execution from the existence of a metadata-only directory', async () => {
  const f = fixture(), router = new GatewayRuntimeRouter(f.adapter)
  await expect(router.resolve(user, { runtimeId: entry.id, target: null, scopeCookie: 'personal' }))
    .rejects.toMatchObject({ code: 'runtime-catalog/unavailable', status: 503 })
})

it('resolves an existing personal selector to its actual computer before local adapters run', async () => {
  const remote = { ...entry, node: { ...entry.node, id: '20222222-2222-4222-8222-222222222222' as RuntimeNodeId } }
  const f = fixture(remote)
  expect(await f.router.placement(user, { runtimeId: null, target: 'personal', scopeCookie: 'project:20' }))
    .toEqual({ environment: remote, target: 'personal', local: false, resetScope: false })
  await expect(f.router.resolve(user, { runtimeId: null, target: null, scopeCookie: undefined }))
    .rejects.toMatchObject({ code: 'runtime-catalog/remote-unavailable' })
  expect(f.getById).not.toHaveBeenCalled()
  expect(f.projectForUser).not.toHaveBeenCalled()
})

it('retains an explicitly selected inaccessible or ambiguous owner instead of choosing another environment', async () => {
  const f = fixture()
  f.catalog.resolveForOwner.mockRejectedValue(new RuntimeCatalogError(409, 'runtime-catalog/ambiguous-target'))
  await expect(f.router.placement(user, { runtimeId: null, target: null, scopeCookie: 'project:20' }))
    .rejects.toMatchObject({ code: 'runtime-catalog/ambiguous-target', status: 409 })
  expect(f.catalog.resolveForOwner).toHaveBeenCalledTimes(1)
  expect(f.projectForUser).not.toHaveBeenCalled()
})

it('opens the personal default for a targetless browser entry while owner APIs retain ambiguity', async () => {
  const f = fixture()
  f.catalog.resolveForOwner.mockRejectedValue(new RuntimeCatalogError(409, 'runtime-catalog/ambiguous-target'))
  const selection = { runtimeId: null, target: null, scopeCookie: undefined }
  expect(await f.router.landing(user, selection)).toEqual({ environment: entry, target: 'personal', local: true, resetScope: false })
  expect(f.catalog.resolveForLanding).toHaveBeenCalledExactlyOnceWith(user)
  await expect(f.router.placement(user, selection)).rejects.toMatchObject({ code: 'runtime-catalog/ambiguous-target' })
})

it.each(['personal', 'project:20'])('does not replace the explicit browser target %s with a default', async (target) => {
  const f = fixture()
  f.catalog.resolveForOwner.mockRejectedValue(new RuntimeCatalogError(409, 'runtime-catalog/ambiguous-target'))
  await expect(f.router.landing(user, { runtimeId: null, target, scopeCookie: undefined }))
    .rejects.toMatchObject({ code: 'runtime-catalog/ambiguous-target' })
  expect(f.catalog.resolveForLanding).not.toHaveBeenCalled()
})

it('repairs only the implicit project cookie when personal assignments require a landing default', async () => {
  const f = fixture()
  f.catalog.resolveForOwner.mockRejectedValue(new RuntimeCatalogError(409, 'runtime-catalog/ambiguous-target'))
  expect(await f.router.landing(user, { runtimeId: null, target: null, scopeCookie: 'project:20' }))
    .toEqual({ environment: entry, target: 'personal', local: true, resetScope: true })
  expect(f.getById).not.toHaveBeenCalled()
  expect(f.projectForUser).not.toHaveBeenCalled()
})

it('retains an inaccessible exact browser Runtime and refuses revoked landing authority', async () => {
  const f = fixture()
  f.catalog.resolveForAccount.mockRejectedValue(new RuntimeCatalogError(404, 'runtime-catalog/not-found'))
  await expect(f.router.landing(user, { runtimeId: entry.id, target: null, scopeCookie: undefined })).rejects.toMatchObject({ status: 404 })
  f.catalog.resolveForOwner.mockRejectedValue(new RuntimeCatalogError(403, 'runtime-catalog/forbidden'))
  await expect(f.router.landing(user, { runtimeId: null, target: null, scopeCookie: undefined })).rejects.toMatchObject({ status: 403 })
  expect(f.catalog.resolveForLanding).not.toHaveBeenCalled()
})

it('repairs an unavailable legacy project cookie but refuses an explicit project request', async () => {
  const f = fixture()
  expect(await f.router.resolve(user, { runtimeId: null, target: null, scopeCookie: 'project:20' })).toMatchObject({ resetScope: true, context: { scope: { kind: 'personal' } } })
  await expect(f.router.resolve(user, { runtimeId: null, target: 'project:20', scopeCookie: 'personal' })).rejects.toMatchObject({ code: 'not-member' })
})

it.each(['', 'project:0', 'project:9007199254740992', 'https://another-node.invalid'])('refuses malformed explicit legacy target %s', async target => {
  await expect(fixture().router.resolve(user, { runtimeId: null, target, scopeCookie: 'personal' })).rejects.toMatchObject({ message: 'invalid-runtime-target' })
})

it.each([false, true])('uses current project management authority %s without loading the member directory', async canManage => {
  const f = fixture()
  f.projectForUser.mockResolvedValue({ projectId: 20, name: 'Project', path: '/project', mode: 'rw',
    administrator: false, canManage, uiThemePolicy: 'dark' })
  expect(await f.adapter.project({ ...user, role: 'admin' }, 20)).toMatchObject({
    scope: { kind: 'project', mode: 'rw', canManage, uiThemePolicy: 'dark' },
    runtime: { kind: 'project', id: 20, path: '/project' },
  })
  expect(f.projectForUser).toHaveBeenCalledExactlyOnceWith(20, user.id)
  expect(f.getById).not.toHaveBeenCalled()
})

it('does not retain project authority after its current membership is withdrawn', async () => {
  const f = fixture()
  f.projectForUser.mockResolvedValueOnce({ projectId: 20, name: 'Project', path: '/project', mode: 'rw',
    administrator: false, canManage: true, uiThemePolicy: 'light' }).mockResolvedValueOnce(null)
  expect(await f.adapter.project(user, 20)).toMatchObject({ scope: { canManage: true } })
  expect(await f.adapter.project(user, 20)).toBeNull()
  expect(f.getById).not.toHaveBeenCalled()
})
