/** Target lifetime and namespace revision fences for administrator configuration. */
import { expect, it, vi } from 'vitest'
import { ProfileSettingsController } from './settings-store.ts'
import type { ProfileSettingsRemote } from './transport.ts'
import type { SettingsNamespaceView } from '../../../../packages/host/apiproxy/src/api/settings.ts'

const view: SettingsNamespaceView = { ns: 'shell', schema: {}, value: { timeoutMs: 1000 }, applies: 'live', secrets: [], revision: 1, owner: 'deployment' }
const described = (namespaces = [view]) => ({ ok: true as const, value: { writable: true, hasDocument: false, namespaces } })
function fixture() {
  const remote: ProfileSettingsRemote = { describe: vi.fn(async () => described()), mutate: vi.fn(async () => ({ ok: true as const, value: { ...view, revision: 2 } })) }
  const controller = new ProfileSettingsController(remote)
  return { controller, remote }
}
it('loads registered namespaces without duplicating account preferences and accepts only the selected namespace', async () => {
  const { controller, remote } = fixture()
  vi.mocked(remote.describe).mockResolvedValueOnce(described([view, { ...view, ns: 'theme', owner: 'account' }]))
  await controller.load()
  expect(controller.ledger.getSnapshot().items).toEqual([{ id: 'shell', label: 'shell' }])
  await controller.save('shell', [{ op: 'unset', path: ['timeoutMs'] }], 1)
  expect(remote.mutate).toHaveBeenCalledWith({ ns: 'shell', ops: [{ op: 'unset', path: ['timeoutMs'] }], expectedRevision: 1 })
  expect(controller.state.getSnapshot().namespaces[0]?.revision).toBe(2)
  vi.mocked(remote.mutate).mockResolvedValueOnce({ ok: true, value: { ...view, ns: 'another' } })
  expect(await controller.save('shell', [], 2)).toMatchObject({ ok: false, error: { code: 'wrong-namespace' } })
  expect(controller.state.getSnapshot().namespaces[0]?.revision).toBe(2)
})
it('discards old reads when a newer load or accepted mutation has superseded them', async () => {
  const { controller, remote } = fixture()
  await controller.load()
  const pending = Promise.withResolvers<Awaited<ReturnType<ProfileSettingsRemote['describe']>>>()
  vi.mocked(remote.describe).mockImplementationOnce(() => pending.promise)
  const old = controller.load()
  await controller.save('shell', [], 1)
  pending.resolve(described())
  await old
  expect(controller.state.getSnapshot().namespaces[0]?.revision).toBe(2)
  vi.mocked(remote.describe).mockResolvedValueOnce(described([{ ...view, revision: 5 }]))
  await controller.load()
  await controller.save('shell', [], 2)
  expect(controller.state.getSnapshot().namespaces[0]?.revision).toBe(5)
})
it('refreshes conflicts, preserves diagnostics and ignores settlements after disposal', async () => {
  const { controller, remote } = fixture()
  await controller.load()
  vi.mocked(remote.mutate).mockResolvedValueOnce({ ok: false, error: { code: 'settings-conflict', message: 'changed elsewhere' } })
  vi.mocked(remote.describe).mockResolvedValueOnce(described([{ ...view, revision: 5 }]))
  expect(await controller.save('shell', [], 1)).toMatchObject({ ok: false })
  expect(controller.state.getSnapshot().namespaces[0]?.revision).toBe(5)
  vi.mocked(remote.describe).mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'offline' } })
  await controller.load()
  expect(controller.state.getSnapshot()).toMatchObject({ loading: false, error: 'offline' })
  const pending = Promise.withResolvers<Awaited<ReturnType<ProfileSettingsRemote['mutate']>>>()
  vi.mocked(remote.mutate).mockImplementationOnce(() => pending.promise)
  const save = controller.save('shell', [], 5)
  controller.dispose()
  pending.resolve({ ok: true, value: { ...view, revision: 6 } })
  expect(await save).toMatchObject({ ok: false, error: { code: 'disposed' } })
  expect(controller.ledger.getSnapshot().items).toEqual([])
  expect(await controller.save('shell', [], 6)).toMatchObject({ ok: false })
  await controller.load()
})
