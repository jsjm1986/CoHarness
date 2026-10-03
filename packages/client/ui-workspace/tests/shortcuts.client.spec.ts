/** Workspace commands capture their business target before the dispatcher executes them. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ShortcutCommand, ShortcutGesture } from '@deepseek-ai/dsh-client-shortcuts/client'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from '../src/client/shortcuts.ts'
import { en, zh } from '../src/client/locales.ts'

const sid = (value: string) => value as SessionId
const context = { region: 'page', modal: null, target: null } as const
const key = (code: string, rest: Partial<ShortcutGesture> = {}): ShortcutGesture => ({
  code, control: false, alt: false, shift: false, meta: true, repeat: false,
  composing: false, defaultPrevented: false, ...rest,
})
const row = (id: string): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, cwd: `/workspace/${id}`, blank: false,
  running: false, updatedAt: 0,
})
const listState = (ids: string[], current?: string): SessionListState => ({
  ids: ids.map(sid),
  byId: Object.fromEntries(ids.map(id => [id, row(id)])),
  archivedById: {},
  current: current === undefined ? undefined : sid(current),
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  observedJobs: {},
  currentAddress: undefined,
})
// Client plugin bundles do not share error-class identity: the command checks
// the name plus the wire code, so the test fabricates the same structural row.
const forkUnavailable = () => Object.assign(
  new Error('session fork failed: session/fork-unavailable: no completed turn'),
  { name: 'SessionForkError', rpcError: { code: 'session/fork-unavailable' } },
)

async function bench(runtime: 'web' | 'desktop' = 'desktop') {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new ShortcutRegistry(runtime, 'macos')
  const commands = new Map<string, ShortcutCommand>()
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => {
    commands.set(command.id, command)
    return registry.register(command)
  }, catalog: registry.catalog } as never)
  const list = createSnapshotStore<SessionListState>(listState(['a', 'b'], 'a'))
  ctx.provide('sessions', { list } as never)
  const directory = createSnapshotStore(true)
  ctx.provide('slots', {
    entries: () => (directory.getSnapshot() ? [{}] : []),
    subscribe: (_name: string, listener: () => void) => directory.subscribe(listener),
  } as never)
  const locale = new LocaleRuntime(ctx)
  locale.register('workspace', { en, zh })
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const navigation = {
    startSession: vi.fn(),
    forkSession: vi.fn(async () => 'fork-child' as SessionId),
  }
  const archiveSession = vi.fn()
  const controls = createWorkspaceShortcutControls()
  const fiber = ctx.plugin((scoped) => {
    installWorkspaceShortcuts(scoped, navigation, controls, archiveSession)
  })
  await fiber.await()
  const select = (id?: string) => { list.set({ ...list.getSnapshot(), current: id === undefined ? undefined : sid(id) }) }
  return { ctx, fiber, registry, commands, navigation, archiveSession, controls, list, directory, select }
}

afterEach(() => { vi.restoreAllMocks() })

describe('workspace shortcut ownership', () => {
  it('refuses rename and archive without a selected Session and keeps a busy picker closed', async () => {
    const b = await bench()
    b.select(undefined)
    for (const id of ['session.rename', 'session.archive']) {
      expect(b.commands.get(id)!.resolve(context)).toMatchObject({ status: 'blocked', reason: en['shortcut.noSession'] })
    }
    b.controls.directoryBusy(true)
    b.controls.add()
    expect(b.controls.state.getSnapshot().addRequested).toBe(false)
  })

  it('registers six commands with Web defaults and removes registrations with the plugin', async () => {
    const b = await bench('web')
    expect(b.registry.catalog.getSnapshot().map(row => row.id)).toEqual([
      'session.new', 'session.search', 'workspace.add', 'session.rename', 'session.fork', 'session.archive',
    ])
    expect(b.registry.catalog.getSnapshot().every(row => row.keys.length > 0)).toBe(true)
    expect(b.registry.catalog.getSnapshot().map(row => row.aria)).toEqual([
      'Alt+Meta+N', 'Alt+Meta+K', 'Alt+Meta+O', 'Shift+Meta+R', 'Shift+Meta+F', 'Alt+Meta+A',
    ])
    await b.fiber.dispose()
    expect(b.registry.catalog.getSnapshot()).toEqual([])
  })

  it('uses the owner for new/search/add from terminals and modals while preserving repeat and directory occupancy', async () => {
    const b = await bench()
    const consume = vi.fn()
    expect(b.registry.dispatch(key('KeyN'), context, consume).status).toBe('handled')
    b.registry.dispatch(key('KeyN', { repeat: true }), context, consume)
    expect(b.navigation.startSession).toHaveBeenCalledOnce()
    expect(b.registry.dispatch(key('KeyN'), { ...context, modal: 'settings' }, consume).status).toBe('handled')
    expect(b.registry.dispatch(key('KeyN'), { ...context, region: 'terminal' }, consume).status).toBe('handled')
    expect(b.navigation.startSession).toHaveBeenCalledTimes(3)
    b.registry.dispatch(key('KeyK'), context, consume)
    expect(b.controls.state.getSnapshot().searchRequest).toBe(1)
    b.registry.dispatch(key('KeyO'), context, consume)
    expect(b.controls.state.getSnapshot().addRequested).toBe(true)
    b.controls.closeAdd()
    b.controls.directoryBusy(true)
    expect(b.registry.dispatch(key('KeyO'), context, consume).status).toBe('blocked')
    expect(b.controls.state.getSnapshot().addRequested).toBe(false)
    b.controls.directoryBusy(false)
    b.directory.set(false)
    expect(b.registry.dispatch(key('KeyO'), context, consume).status).toBe('blocked')
  })

  it('captures rename and archive targets while the current Session changes', async () => {
    const b = await bench()
    for (const command of ['session.rename', 'session.archive']) {
      b.select('a')
      const resolution = b.commands.get(command)!.resolve(context)
      b.select('b')
      expect(resolution.status).toBe('handled')
      if (resolution.status === 'handled') resolution.run()
    }
    expect(b.controls.state.getSnapshot().renameTarget).toEqual({ sessionId: 'a', currentTitle: 'a' })
    expect(b.archiveSession).toHaveBeenCalledWith('a')
  })

  it('captures the source Session and lets the Host choose its last completed turn', async () => {
    const b = await bench()
    const resolution = b.commands.get('session.fork')!.resolve(context)
    b.select('b')
    if (resolution.status !== 'handled') throw new Error('nonblank Session was unavailable')
    resolution.run()
    expect(b.navigation.forkSession).toHaveBeenCalledWith('a')
  })

  it('blocks absent or blank Sessions and permits retry while running after the Host refuses a fork', async () => {
    const b = await bench()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    b.navigation.forkSession.mockRejectedValueOnce(forkUnavailable())
    const invoke = () => b.registry.dispatch(key('KeyF', { alt: true }), context, vi.fn())
    expect(invoke().status).toBe('handled')
    await vi.waitFor(() => { expect(b.controls.state.getSnapshot().forkError).toMatchObject({ reason: 'unavailable' }) })
    expect(warning).not.toHaveBeenCalled()
    b.controls.dismissForkError()
    b.navigation.forkSession.mockRejectedValueOnce(new Error('connection closed'))
    expect(invoke().status).toBe('handled')
    await vi.waitFor(() => { expect(b.controls.state.getSnapshot().forkError).toMatchObject({ reason: 'failed' }) })
    expect(warning).toHaveBeenCalledOnce()
    b.list.set({ ...b.list.getSnapshot(), byId: { [sid('a')]: { ...row('a'), running: true } } })
    expect(invoke().status).toBe('handled')
    expect(b.navigation.forkSession).toHaveBeenCalledTimes(3)
    b.list.set({ ...b.list.getSnapshot(), byId: { [sid('a')]: { ...row('a'), blank: true } } })
    expect(invoke()).toMatchObject({ status: 'blocked', reason: en['shortcut.noCompletedTurn'] })
    b.list.set({ ...b.list.getSnapshot(), byId: {} })
    expect(invoke()).toMatchObject({ status: 'blocked', reason: en['shortcut.noSession'] })
  })

  it('opens an empty rename draft for unnamed history instead of its directory label', async () => {
    const b = await bench()
    const unnamed = row('a')
    delete unnamed.title
    unnamed.displayTitle = 'Default workspace'
    b.list.set({ ...b.list.getSnapshot(), byId: { [unnamed.id]: unnamed } })
    const command = b.commands.get('session.rename')!.resolve(context)
    expect(command.status).toBe('handled')
    if (command.status === 'handled') command.run()
    expect(b.controls.state.getSnapshot().renameTarget).toEqual({ sessionId: 'a', currentTitle: '' })
  })
})
