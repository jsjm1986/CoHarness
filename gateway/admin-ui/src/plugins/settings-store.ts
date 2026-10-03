/** One target's configuration directory, sharing the manager's revocable transport. */
import { createSnapshotStore } from '../../../../packages/client/runtime/src/client/contract/store.ts'
import type { SettingsNamespaceView, SettingsPathOpView } from '../../../../packages/host/apiproxy/src/api/settings.ts'
import type { ConfigLedger, HostObservable } from './config-ledger.ts'
import type { Answer, ProfileSettingsRemote } from './transport.ts'

export interface ProfileSettingsState {
  loading: boolean
  error: string
  namespaces: readonly SettingsNamespaceView[]
}
const emptyLedger = (): ConfigLedger => ({ items: [], bundles: new Set(), rows: new Set() })

/** Keeps configuration reads and write acknowledgments on the selected runtime only. */
export class ProfileSettingsController {
  readonly state = createSnapshotStore<ProfileSettingsState>({ loading: true, error: '', namespaces: [] })
  readonly ledger: HostObservable<ConfigLedger>
  private readonly directory = createSnapshotStore<ConfigLedger>(emptyLedger())
  private generation = 0
  private disposed = false

  constructor(private readonly remote: ProfileSettingsRemote) { this.ledger = this.directory }

  async load(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.state.update(value => { value.loading = true; value.error = '' })
    const result = await this.remote.describe()
    if (this.disposed || generation !== this.generation) return
    if (!result.ok) {
      this.state.update(value => { value.loading = false; value.error = result.error.message })
      return
    }
    const namespaces = result.value.namespaces.filter(item => item.owner !== 'account')
      .map(item => ({ ...item, writable: item.writable ?? result.value.writable }))
      .sort((a, b) => a.ns.localeCompare(b.ns))
    this.state.set({ loading: false, error: '', namespaces })
    const items = namespaces.map(item => ({ id: item.ns, label: item.ns, ...item.label === undefined ? {} : { labelText: item.label } }))
    // Configuration keys follow `rowConfigKey`: `bundle#rowId` marks a row
    // and its package, a bare `bundle` marks the package alone.
    const bundles = new Set<string>()
    const rows = new Set<string>()
    for (const item of items) {
      const split = item.id.indexOf('#')
      if (split < 0) bundles.add(item.id)
      else { bundles.add(item.id.slice(0, split)); rows.add(item.id) }
    }
    this.directory.set({ items, bundles, rows })
  }

  async save(ns: string, ops: SettingsPathOpView[], expectedRevision: number): Promise<Answer<SettingsNamespaceView>> {
    if (this.disposed) return { ok: false, error: { code: 'disposed', message: '所选实例已变化，请重新打开配置。' } }
    const result = await this.remote.mutate({ ns, ops, expectedRevision })
    if (this.disposed) return { ok: false, error: { code: 'disposed', message: '所选实例已变化，请重新打开配置。' } }
    if (result.ok && result.value.ns !== ns) {
      return { ok: false, error: { code: 'wrong-namespace', message: '配置响应与当前插件不一致，请重新读取实例。' } }
    }
    if (result.ok) {
      this.generation++
      this.state.update(state => {
        state.loading = false
        state.error = ''
        state.namespaces = state.namespaces.map(item => item.ns === ns && item.revision <= result.value.revision ? result.value : item)
      })
    } else if (result.error.code === 'settings-conflict') {
      await this.load()
    }
    return result
  }

  dispose(): void { this.disposed = true; this.generation++; this.directory.set(emptyLedger()) }
}
