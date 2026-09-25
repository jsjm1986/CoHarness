/**
 * The agent-preset management controller: a copy dialog is the only way a
 * preset is created, the shipped compositions open in a read-only viewer, and
 * the way into a custom preset's files is the location action — opened on a
 * desktop, revealed as a path where the host has none. Every mutation
 * re-reads the roster because a copy changes more than the row it targeted.
 */

import { describe, expect, it } from 'vitest'
import type { ClientRemote, IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsWritableReason } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPresetSectionController, draftBlocker } from '../src/client/section-store.ts'
import type { CopyDraft, PresetRow } from '../src/client/section-store.ts'

interface FakePreset { trust: 'system' | 'user'; content: string; name?: string }
interface Recorded { method: string; payload: unknown }

interface FakeOptions {
  /** Every call the controller made, in order. */
  calls?: Recorded[]
  /** Reject `list` with this message. */
  failList?: string
  /** Reject `list` only on this ordinal call. */
  failListAt?: number
  /** Reject `read` with this message. */
  failRead?: string
  /** Reject `copy` with this message. */
  failCopy?: string
  /** Reject `openDocument` with this message. */
  failOpen?: string
  /** Reject `remove` with this message. */
  failRemove?: string
  /** Reject `settings.update` with this message. */
  failSettings?: string
  /** Throw from `settings.update` rather than answering, as a dead transport does. */
  throwSettings?: unknown
  /** Throw from `list` rather than answering, as a dead transport does. */
  throwList?: boolean
  /** Throw from `read`, as a dead transport does. */
  throwRead?: boolean
  /** Throw from `copy`, as a dead transport does. */
  throwCopy?: boolean
  /** Throw from `openDocument`, as a dead transport does. */
  throwOpen?: boolean
  /** Whether the deployment configures a writable root. */
  authorable?: boolean
  /** Whether the host can open a preset directory on a desktop. */
  hasDocument?: boolean
  /** Hold `remove` until this resolves, to observe the in-flight state. */
  holdRemove?: Promise<void>
  /** Initial new-session picker visibility. */
  showPicker?: boolean
  /** Mutable Host policy used when a Settings write is reflected by the roster. */
  pickerPolicy?: { enabled: boolean }
  /** Simulate a concurrent Host write winning after this client's policy write. */
  ignorePickerWrite?: boolean
  /** Whether the shared mirror reports the namespace writable. */
  writable?: boolean
  /** The mirror's writable reason when {@link writable} is false. */
  writableReason?: SettingsWritableReason
}

const ok = (value: unknown) => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value } })
const fail = (message: string) =>
  Promise.resolve({ rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message, details: {} } } })
const remoteOk = (value: unknown) => Promise.resolve({ ok: true as const, value })
const remoteFail = (message: string) =>
  Promise.resolve({ ok: false as const, error: { code: 'internal', message, details: {} } })

/**
 * A wire face over an in-memory preset store: copies land, so the roster the
 * controller re-reads after a copy is the one the copy produced.
 * @param presets - the starting compositions by id.
 * @param defaultId - the preset a session with no choice gets.
 * @param options - failure injection and call recording.
 * @returns the fake client.
 */
function fakeRemote(
  presets: Map<string, FakePreset>,
  defaultId: { id: string },
  options: FakeOptions = {},
): Pick<ClientRemote, 'agentPresets'> {
  const record = (method: string, payload: unknown): void => { options.calls?.push({ method, payload }) }
  let listCount = 0
  return {
    agentPresets: {
      list: () => {
        record('list', {})
        listCount += 1
        if (options.throwList === true) return Promise.reject(new Error('socket closed'))
        if (options.failList !== undefined
          && (options.failListAt === undefined || options.failListAt === listCount)) {
          return remoteFail(options.failList)
        }
        const selectionEnabled = options.pickerPolicy?.enabled ?? options.showPicker ?? true
        // The Host resolves the saved default only while selection is shown;
        // hidden, the effective default is the composition default.
        const effectiveDefault = selectionEnabled ? defaultId.id : 'standard'
        return remoteOk({
          presets: [...presets].map(([id, preset]) => ({
            id, trust: preset.trust, isDefault: id === effectiveDefault,
            ...preset.name === undefined ? {} : { name: preset.name },
          })),
          authorable: options.authorable ?? true,
          modeSelectionEnabled: selectionEnabled,
        })
      },
      read: (id: string) => {
        record('read', { agentPreset: id })
        if (options.throwRead === true) return Promise.reject(new Error('socket closed'))
        if (options.failRead !== undefined) return remoteFail(options.failRead)
        const preset = presets.get(id)
        /* v8 ignore next -- every test reads an id the fake store holds */
        if (preset === undefined) return remoteFail(`unknown preset ${id}`)
        return remoteOk({
          agentPreset: id,
          trust: preset.trust,
          content: preset.content,
          ...preset.name === undefined ? {} : { name: preset.name },
        })
      },
      copy: (from: string, id: string, name?: string) => {
        record('copy', { from, agentPreset: id, ...name === undefined ? {} : { name } })
        if (options.throwCopy === true) return Promise.reject(new Error('socket closed'))
        if (options.failCopy !== undefined) return remoteFail(options.failCopy)
        const source = presets.get(from)
        /* v8 ignore next -- every test copies a source the fake store holds */
        if (source === undefined) return remoteFail(`unknown preset ${from}`)
        presets.set(id, {
          trust: 'user',
          content: source.content,
          ...name === undefined ? {} : { name },
        })
        return remoteOk(undefined)
      },
      deletePreset: async (id: string) => {
        record('deletePreset', { agentPreset: id })
        await options.holdRemove
        if (options.failRemove !== undefined) return await remoteFail(options.failRemove)
        presets.delete(id)
        return await remoteOk(undefined)
      },
    },
  } as unknown as Pick<ClientRemote, 'agentPresets'>
}

function fakeApi(defaultId: { id: string }, options: FakeOptions = {}): Pick<IApiClient, 'agentPresets' | 'settings'> {
  const record = (method: string, payload: unknown): void => { options.calls?.push({ method, payload }) }
  return {
    agentPresets: {
      openDocument: (payload: { agentPreset: string }) => {
        record('openDocument', payload)
        if (options.throwOpen === true) return Promise.reject(new Error('socket closed'))
        if (options.failOpen !== undefined) return fail(options.failOpen)
        return (options.hasDocument ?? true)
          ? ok({ opened: true })
          : ok({ opened: false, path: `/presets/${payload.agentPreset}` })
      },
    },
    settings: {
      update: (payload: { ns: string; patch: { default?: unknown; modeSelectionEnabled?: unknown } }) => {
        record('settings.update', payload)
        if (options.throwSettings !== undefined) throw options.throwSettings
        if (options.failSettings !== undefined) return fail(options.failSettings)
        if (typeof payload.patch.default === 'string') defaultId.id = payload.patch.default
        if (typeof payload.patch.modeSelectionEnabled === 'boolean' && !options.ignorePickerWrite) {
          const policy = options.pickerPolicy ?? { enabled: options.showPicker ?? true }
          policy.enabled = payload.patch.modeSelectionEnabled
        }
        return ok({})
      },
    },
  } as unknown as Pick<IApiClient, 'agentPresets' | 'settings'>
}

function seed(): Map<string, FakePreset> {
  return new Map<string, FakePreset>([
    ['standard', { trust: 'system', content: '- id: tool-bash\n', name: '标准模式' }],
    ['mine', { trust: 'user', content: '- id: tool-read\n' }],
  ])
}

/**
 * The shared describe mirror over one namespace's writability: the section
 * reads it per load, exactly as the row does.
 * @param options - the fake's writable flag and reason.
 * @returns a describe face the controller accepts.
 */
function fakeDescribe(options: FakeOptions): SettingsDescribeFace {
  const writable = options.writable ?? true
  return {
    getSnapshot: () => ({
      status: 'ready',
      view: {
        writable,
        hasDocument: true,
        namespaces: [{
          ns: 'agent-presets',
          schema: {},
          value: {},
          applies: 'live',
          revision: 0,
          writable,
          ...writable || options.writableReason === undefined
            ? {}
            : { writableReason: options.writableReason },
        }],
      },
      error: null,
    }),
    subscribe: () => () => {},
    ensure: () => Promise.resolve(),
    acceptView: () => {},
  } as unknown as SettingsDescribeFace
}

function harness(options: FakeOptions = {}) {
  const presets = seed()
  const defaultId = { id: 'standard' }
  const calls: Recorded[] = []
  let rosterChanges = 0
  const pickerPolicy = options.pickerPolicy ?? { enabled: options.showPicker ?? true }
  const shared = { ...options, pickerPolicy, calls: options.calls ?? calls }
  const controller = new AgentPresetSectionController(
    fakeRemote(presets, defaultId, shared),
    fakeApi(defaultId, shared),
    () => options.hasDocument ?? true,
    fakeDescribe(options),
    () => { rosterChanges += 1 },
  )
  return {
    controller, presets, defaultId, pickerPolicy, calls,
    rosterChanges: () => rosterChanges,
  }
}

function copyOf(controller: AgentPresetSectionController): CopyDraft {
  const { copy } = controller.store.getSnapshot()
  if (copy === null) throw new Error('expected an open copy dialog')
  return copy
}

describe('loading the roster', () => {
  it('maps the roster onto rows with the capability flags', async () => {
    const { controller } = harness({ authorable: true, hasDocument: false })

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.authorable).toBe(true)
    expect(state.hasDocument).toBe(false)
    expect(state.rows.map((row: PresetRow) => row.id)).toEqual(['standard', 'mine'])
    expect(state.rows[0]).toMatchObject({ trust: 'system', isDefault: true, name: '标准模式' })
  })

  it('reports an empty roster as unavailable, not as an error', async () => {
    const { controller, presets } = harness()
    presets.clear()

    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('unavailable')
  })

  it('keeps one load in flight rather than stacking reads', async () => {
    const { controller, calls } = harness()

    await Promise.all([controller.load(), controller.load()])

    expect(calls.filter(call => call.method === 'list')).toHaveLength(1)
  })

  it('surfaces a refusal as the page error', async () => {
    const { controller } = harness({ failList: 'not for you' })

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('not for you')
  })

  it('folds a dead transport into the same error surface', async () => {
    const { controller } = harness({ throwList: true })

    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toContain('socket closed')
  })
})

describe('the read-only viewer', () => {
  it('opens a shipped composition under its display name', async () => {
    const { controller } = harness()
    await controller.load()

    await controller.view('standard')

    expect(controller.store.getSnapshot().view).toEqual({
      id: 'standard', title: '标准模式', content: '- id: tool-bash\n',
    })
  })

  it('falls back to the id when the preset published no name', async () => {
    const { controller } = harness()
    await controller.load()

    await controller.view('mine')

    expect(controller.store.getSnapshot().view?.title).toBe('mine')
  })

  it('closes without touching the list', async () => {
    const { controller } = harness()
    await controller.load()
    await controller.view('standard')

    controller.closeView()

    expect(controller.store.getSnapshot().view).toBeNull()
    expect(controller.store.getSnapshot().rows).toHaveLength(2)
  })

  it('puts a read refusal on the page rather than opening empty', async () => {
    const { controller } = harness({ failRead: 'no peeking' })
    await controller.load()

    await controller.view('standard')

    expect(controller.store.getSnapshot().view).toBeNull()
    expect(controller.store.getSnapshot().error).toBe('no peeking')
  })

  it('folds a dead transport into the same error surface', async () => {
    const { controller } = harness({ throwRead: true })
    await controller.load()

    await controller.view('standard')

    expect(controller.store.getSnapshot().error).toContain('socket closed')
  })
})

describe('the copy dialog', () => {
  it('opens over the source with its display name in the title', async () => {
    const { controller } = harness()
    await controller.load()

    controller.beginCopy('standard')

    expect(copyOf(controller)).toMatchObject({
      from: 'standard', fromTitle: '标准模式', id: '', name: '', saving: false,
    })
  })

  it('falls back to the source id when it published no name', async () => {
    const { controller } = harness()
    await controller.load()

    controller.beginCopy('mine')

    expect(copyOf(controller).fromTitle).toBe('mine')
  })

  it('cancel discards whatever was typed', async () => {
    const { controller } = harness()
    await controller.load()
    controller.beginCopy('standard')
    controller.setCopyId('half-typed')

    controller.cancelCopy()

    expect(controller.store.getSnapshot().copy).toBeNull()
  })

  it('ignores field edits and submits with no dialog open', async () => {
    const { controller, calls } = harness()
    await controller.load()

    controller.setCopyId('typed-into-nothing')
    controller.setCopyName('nameless')
    await controller.confirmCopy()

    expect(controller.store.getSnapshot().copy).toBeNull()
    expect(calls.some(call => call.method === 'copy')).toBe(false)
  })

  it('typing clears the previous failure', async () => {
    const { controller } = harness({ failCopy: 'disk full' })
    await controller.load()
    controller.beginCopy('standard')
    controller.setCopyId('my-copy')
    await controller.confirmCopy()
    expect(copyOf(controller).error).toBe('disk full')

    controller.setCopyName('renamed')

    expect(copyOf(controller).error).toBeNull()
  })
})

describe('the copy blocker', () => {
  const rows: PresetRow[] = [
    { id: 'standard', trust: 'system', isDefault: true },
    { id: 'mine', trust: 'user', isDefault: false },
  ]
  const draft = (id: string): CopyDraft =>
    ({ from: 'standard', fromTitle: '标准模式', id, name: '', saving: false, error: null })

  it('requires an id, a containable shape, and a free name', () => {
    expect(draftBlocker(draft(''), rows)).toBe('idRequired')
    expect(draftBlocker(draft('../escape'), rows)).toBe('idInvalid')
    expect(draftBlocker(draft('Upper'), rows)).toBe('idInvalid')
    expect(draftBlocker(draft('mine'), rows)).toBe('idTaken')
    expect(draftBlocker(draft('my-copy'), rows)).toBeUndefined()
  })
})

describe('submitting a copy', () => {
  it('copies, re-reads the roster, announces the change, and opens the files', async () => {
    const { controller, calls, rosterChanges } = harness()
    await controller.load()
    controller.beginCopy('standard')
    controller.setCopyId('my-copy')
    controller.setCopyName('我的模式')

    await controller.confirmCopy()

    const state = controller.store.getSnapshot()
    expect(state.copy).toBeNull()
    expect(state.rows.map(row => row.id)).toContain('my-copy')
    expect(rosterChanges()).toBe(1)
    expect(calls.find(call => call.method === 'copy')?.payload)
      .toEqual({ from: 'standard', agentPreset: 'my-copy', name: '我的模式' })
    // A preset is its files from here on, so landing in them completes the
    // copy rather than following it.
    expect(calls.find(call => call.method === 'openDocument')?.payload)
      .toEqual({ agentPreset: 'my-copy' })
  })

  it('omits an empty name so the copy falls back to its id', async () => {
    const { controller, calls } = harness()
    await controller.load()
    controller.beginCopy('standard')
    controller.setCopyId('my-copy')
    controller.setCopyName('   ')

    await controller.confirmCopy()

    expect(calls.find(call => call.method === 'copy')?.payload)
      .toEqual({ from: 'standard', agentPreset: 'my-copy' })
  })

  it('reveals the new directory as text where the host has no desktop', async () => {
    const { controller } = harness({ hasDocument: false })
    await controller.load()
    controller.beginCopy('standard')
    controller.setCopyId('my-copy')

    await controller.confirmCopy()

    expect(controller.store.getSnapshot().revealedPaths['my-copy']).toBe('/presets/my-copy')
  })

  it('keeps the dialog open with the refusal on it', async () => {
    const { controller, rosterChanges } = harness({ failCopy: 'id already exists' })
    await controller.load()
    controller.beginCopy('standard')
    controller.setCopyId('my-copy')

    await controller.confirmCopy()

    expect(copyOf(controller)).toMatchObject({ saving: false, error: 'id already exists' })
    expect(rosterChanges()).toBe(0)
  })

  it('folds a dead transport into the dialog error', async () => {
    const { controller } = harness({ throwCopy: true })
    await controller.load()
    controller.beginCopy('standard')
    controller.setCopyId('my-copy')

    await controller.confirmCopy()

    expect(copyOf(controller).error).toContain('socket closed')
  })

  it('refuses to submit while blocked or already saving', async () => {
    const { controller, calls } = harness()
    await controller.load()
    controller.beginCopy('standard')
    controller.setCopyId('mine')

    await controller.confirmCopy()

    expect(calls.some(call => call.method === 'copy')).toBe(false)
  })
})

describe('the location action', () => {
  it('opens the directory and leaves the page alone on a desktop host', async () => {
    const { controller, calls } = harness()
    await controller.load()

    await controller.openLocation('mine')

    expect(calls.find(call => call.method === 'openDocument')?.payload).toEqual({ agentPreset: 'mine' })
    expect(controller.store.getSnapshot().revealedPaths).toEqual({})
  })

  it('reveals the path on the row where the host has none', async () => {
    const { controller } = harness({ hasDocument: false })
    await controller.load()

    await controller.openLocation('mine')

    expect(controller.store.getSnapshot().revealedPaths).toEqual({ mine: '/presets/mine' })
  })

  it('drops a revealed path once its preset leaves the roster', async () => {
    const { controller, presets } = harness({ hasDocument: false })
    await controller.load()
    await controller.openLocation('mine')
    presets.delete('mine')

    await controller.load()

    expect(controller.store.getSnapshot().revealedPaths).toEqual({})
  })

  it('surfaces a refusal as the page error', async () => {
    const { controller } = harness({ failOpen: 'not yours' })
    await controller.load()

    await controller.openLocation('mine')

    expect(controller.store.getSnapshot().error).toBe('not yours')
  })

  it('folds a dead transport into the same error surface', async () => {
    const { controller } = harness({ throwOpen: true })
    await controller.load()

    await controller.openLocation('mine')

    expect(controller.store.getSnapshot().error).toContain('socket closed')
  })
})

describe('deleting', () => {
  it('asks first, then deletes, re-reads, and announces the change', async () => {
    const { controller, rosterChanges } = harness()
    await controller.load()

    controller.confirmDelete('mine')
    expect(controller.store.getSnapshot().pendingDelete).toBe('mine')
    await controller.remove()

    const state = controller.store.getSnapshot()
    expect(state.pendingDelete).toBeNull()
    expect(state.rows.map(row => row.id)).not.toContain('mine')
    expect(rosterChanges()).toBe(1)
  })

  it('dismisses the confirmation without deleting', async () => {
    const { controller, calls } = harness()
    await controller.load()
    controller.confirmDelete('mine')

    controller.confirmDelete(null)
    await controller.remove()

    expect(controller.store.getSnapshot().rows.map(row => row.id)).toContain('mine')
    expect(calls.some(call => call.method === 'deletePreset')).toBe(false)
  })

  it('ignores a second confirmation while one delete is in flight', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { controller, calls } = harness({ holdRemove: gate })
    await controller.load()
    controller.confirmDelete('mine')
    const removal = controller.remove()

    controller.confirmDelete('standard')
    await controller.remove()
    release()
    await removal

    expect(calls.filter(call => call.method === 'deletePreset')).toHaveLength(1)
  })

  it('surfaces a refusal and clears the confirmation', async () => {
    const { controller } = harness({ failRemove: 'shipped preset' })
    await controller.load()
    controller.confirmDelete('mine')

    await controller.remove()

    const state = controller.store.getSnapshot()
    expect(state.error).toBe('shipped preset')
    expect(state.pendingDelete).toBeNull()
    expect(state.deleting).toBe(false)
  })

  it('folds a dead transport into the same error surface', async () => {
    const { controller, presets } = harness()
    await controller.load()
    presets.clear()
    const broken = new AgentPresetSectionController({
      agentPresets: {
        list: () => Promise.reject(new Error('gone')),
        deletePreset: () => Promise.reject(new Error('socket closed')),
      },
    } as unknown as Pick<ClientRemote, 'agentPresets'>,
    fakeApi({ id: 'standard' }), () => true, fakeDescribe({}))
    broken.store.set({ ...broken.store.getSnapshot(), authorable: true, rows: [{
      id: 'mine', trust: 'user', isDefault: false,
    }] })
    broken.confirmDelete('mine')

    await broken.remove()

    expect(broken.store.getSnapshot().error).toContain('socket closed')
  })
})

describe('a controller with no roster listener', () => {
  it('completes a delete without anyone to notify', async () => {
    // The rosterChanged callback is optional wiring, not a requirement: a
    // page composed without sibling surfaces still deletes cleanly.
    const presets = seed()
    const alone = new AgentPresetSectionController(
      fakeRemote(presets, { id: 'standard' }), fakeApi({ id: 'standard' }), () => true,
      fakeDescribe({}),
    )
    await alone.load()
    alone.confirmDelete('mine')

    await alone.remove()

    expect(alone.store.getSnapshot().rows.map(row => row.id)).not.toContain('mine')
  })
})

describe('the default preset', () => {
  it('writes the setting and re-reads the roster', async () => {
    const { controller, defaultId } = harness()
    await controller.load()

    await controller.makeDefault('mine')

    expect(defaultId.id).toBe('mine')
    expect(controller.store.getSnapshot().rows.find(row => row.id === 'mine')?.isDefault).toBe(true)
  })

  it('syncs the still-blank session with the Host-effective default', async () => {
    const { controller, defaultId } = harness()
    const synced: string[] = []
    const sync = (id: string): Promise<undefined> => {
      synced.push(id)
      return Promise.resolve(undefined)
    }
    await controller.load()

    // A concurrent Host write that lands after this client's write is the
    // value the roster reports — the sync follows the roster, not the patch.
    const makingDefault = controller.makeDefault('mine', sync)
    defaultId.id = 'standard'
    await makingDefault

    expect(controller.store.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('standard')
    expect(synced).toEqual(['standard'])

    // A default that resolves to no roster row leaves the session alone.
    const missingDefault = controller.makeDefault('mine', sync)
    defaultId.id = 'missing'
    await missingDefault
    expect(synced).toEqual(['standard'])
  })

  it('surfaces a settings refusal as the page error', async () => {
    const { controller } = harness({ failSettings: 'read-only settings' })
    await controller.load()

    await controller.makeDefault('mine')

    expect(controller.store.getSnapshot().error).toContain('read-only settings')
  })

  it('keeps a composition sync failure on the page', async () => {
    const { controller } = harness()
    await controller.load()

    await controller.makeDefault(
      'mine',
      () => Promise.resolve('blank session rejected the preset'),
    )

    expect(controller.store.getSnapshot()).toMatchObject({
      error: 'blank session rejected the preset', policySaving: false,
    })
  })

  it('restores the policy lock after a thrown default write', async () => {
    const { controller } = harness({ throwSettings: new Error('settings transport unavailable') })
    await controller.load()

    await controller.makeDefault('mine')

    expect(controller.store.getSnapshot()).toMatchObject({
      error: 'settings transport unavailable', policySaving: false,
    })
  })

  it('ignores default writes while mode selection is disabled', async () => {
    const { controller, calls } = harness({ showPicker: false })
    await controller.load()

    await controller.makeDefault('mine')

    expect(calls.some(call => call.method === 'settings.update')).toBe(false)
  })

  it('ignores default writes while the namespace is read-only', async () => {
    const { controller, calls } = harness({ writable: false, writableReason: 'project' })
    await controller.load()

    await controller.makeDefault('mine')

    expect(calls.some(call => call.method === 'settings.update')).toBe(false)
    expect(controller.store.getSnapshot().policyWritableReason).toBe('project')
  })
})

describe('the new-session picker preference', () => {
  it('ignores policy writes until the section is ready', async () => {
    const { controller, calls } = harness({ showPicker: true })

    await controller.setPickerVisible(false)

    expect(calls.some(call => call.method === 'settings.update')).toBe(false)
  })

  it('ignores policy writes while the namespace is read-only', async () => {
    const { controller, calls } = harness({ showPicker: true, writable: false })
    await controller.load()

    await controller.setPickerVisible(false)

    expect(calls.some(call => call.method === 'settings.update')).toBe(false)
  })

  it('uses the composition default while disabled and restores the saved default when re-enabled', async () => {
    const { controller, calls, defaultId } = harness({
      showPicker: true, failList: 'connection moved', failListAt: 2,
    })
    const synced: string[] = []
    const sync = (id: string): Promise<undefined> => {
      synced.push(id)
      return Promise.resolve(undefined)
    }
    defaultId.id = 'mine'
    await controller.load()
    expect(controller.store.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('mine')

    await controller.setPickerVisible(false, sync)
    expect(calls.filter(call => call.method === 'settings.update')[0]?.payload)
      .toEqual({ ns: 'agent-presets', patch: { modeSelectionEnabled: false } })

    expect(controller.store.getSnapshot()).toMatchObject({
      showPicker: false, policySaving: false,
    })
    expect(controller.store.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('standard')

    await controller.setPickerVisible(true, sync)
    expect(calls.filter(call => call.method === 'settings.update')[1]?.payload)
      .toEqual({ ns: 'agent-presets', patch: { modeSelectionEnabled: true } })
    expect(controller.store.getSnapshot()).toMatchObject({
      showPicker: true, policySaving: false,
    })
    expect(controller.store.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('mine')
    expect(synced).toEqual(['standard', 'mine'])
  })

  it('reloads Host truth and reports a refused visibility write', async () => {
    const { controller } = harness({ showPicker: true, failSettings: 'read-only settings' })
    await controller.load()

    await controller.setPickerVisible(false)

    expect(controller.store.getSnapshot()).toMatchObject({
      showPicker: true, error: 'read-only settings', policySaving: false,
    })
  })

  it('reloads Host truth when another policy value wins the write', async () => {
    const { controller } = harness({ showPicker: true, ignorePickerWrite: true })
    await controller.load()

    await controller.setPickerVisible(false)

    expect(controller.store.getSnapshot()).toMatchObject({ showPicker: true, policySaving: false })
  })

  it('reloads a roster that cannot mark an effective default', async () => {
    const { controller, defaultId } = harness({ showPicker: false })
    defaultId.id = 'missing'
    await controller.load()

    await controller.setPickerVisible(true)

    expect(controller.store.getSnapshot()).toMatchObject({ showPicker: true, policySaving: false })
    expect(controller.store.getSnapshot().rows.every(row => !row.isDefault)).toBe(true)
  })

  it('keeps a blank-session sync failure on the page', async () => {
    const { controller } = harness({ showPicker: true })
    await controller.load()

    await controller.setPickerVisible(
      false,
      () => Promise.resolve('blank session rejected the policy'),
    )

    expect(controller.store.getSnapshot()).toMatchObject({
      error: 'blank session rejected the policy', policySaving: false,
    })
  })

  it('reloads Host truth after a thrown visibility write', async () => {
    const { controller } = harness({ showPicker: true, throwSettings: new Error('connection lost') })
    await controller.load()

    await controller.setPickerVisible(false)

    expect(controller.store.getSnapshot()).toMatchObject({
      showPicker: true, error: 'connection lost', policySaving: false,
    })
  })
})
