// @vitest-environment jsdom
/**
 * ui-deliverables browser half: the derivation contract of
 * `producedForClosing` over engine-published Turn data, the row's rendering
 * and opener wiring, and the plugin registrations' fiber-teardown removal
 * (HMR safety) against the real SlotRegistry.
 */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSnapshotStore, ConversationEventRegistry, ConversationNodeAssembler, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  ConversationEventInput, ConversationLocationDataStore, ConversationMatch, ConversationNodeDefinition,
  ConversationTimelineSnapshot, ConversationTurnDataMap, ConversationViewDefinition,
  ConversationViewNode, ToolResultNode, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { ChatFileMentions, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { ProducedFiles, type ProducedFilesProps } from '../src/client/ProducedFiles.tsx'
import {
  changesForClosing, presentedForClosing, basename, deliverablesDefinition, producedFileMentions, producedForClosing, selectProducedFiles,
  type DeliverablesTurnData,
} from '../src/client/turn-deliverables.ts'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { Deliverables, DeliverablesTail, selectDeliverables, type DeliverablesInjected } from '../src/client/Deliverables.tsx'
import { ChangesSummaryStore } from '../src/client/changes-summary.ts'
import { PresentedOpenController } from '../src/client/present-open.ts'
import type { ReviewInjected } from '../src/client/ReviewTab.tsx'
import { changesSummaryUrl, changesDiffUrl, changesReviewAddress, type ChangesSummary } from '../src/changes.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

class TestTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly values = new Map<string, unknown>()

  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    this.values.set(key, value)
  }
}

const turnLocation = (turn: number, deliverables?: DeliverablesTurnData): TurnLocation => {
  const data = new TestTurnDataStore()
  if (deliverables !== undefined) data.set('deliverables', deliverables)
  return { turn, start: undefined, end: undefined, status: 'closed', steps: [], data }
}

const produced = (...values: ReadonlyArray<readonly [seq: number, path: string]>): DeliverablesTurnData => ({
  produced: values.map(([seq, path]) => ({ seq, path })),
})

function tailOwner(
  data: DeliverablesTurnData | undefined,
  seq: number,
  openFile: (path: string) => void = () => {},
  turn = 1,
): TurnTailOwnerProps {
  return { seq, openFile, turn: turnLocation(turn, data) }
}

interface TimelineSnapshot {
  readonly timeline: ConversationTimelineSnapshot
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [deliverablesDefinition] }
  fallbackEntry(): ConversationNodeDefinition | undefined { return undefined }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [timelineViewDefinition] }
}

const timelineViewDefinition: ConversationViewDefinition<ConversationViewNode, TimelineSnapshot> = {
  target: 'test',
  create: () => {
    let current: TimelineSnapshot = { timeline: { turnOrder: [], turns: new Map() } }
    return {
      empty: current,
      replace: ({ timeline }) => (current = { timeline }),
      apply: ({ timeline }) => (current = { timeline }),
    }
  },
}

function at(
  seq: number,
  type: string,
  data: unknown,
  view?: ConversationEventInput['view'],
): ConversationEventInput {
  return {
    event: {
      seq, time: seq * 1_000, type, data,
      ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}),
    } as ConversationEventInput['event'],
    view,
  }
}

function matched(input: ConversationEventInput, role: ConversationMatch['role']): ConversationMatch {
  return { ...input, role, location: { kind: 'unresolved' } }
}

function call(
  seq: number,
  callId: string,
  view: ToolResultNode['callView'],
  turn = 1,
): ConversationEventInput {
  return at(
    seq,
    'tool/call',
    { turn, step: 1, callId, name: 'fixture', arguments: '{}' },
    { for: 'call', view: view ?? { card: 'generic', title: 'fixture' } },
  )
}

function result(seq: number, callId: string, isError = false, turn = 1): ConversationEventInput {
  return at(seq, 'tool/result', {
    turn,
    step: 1,
    message: {
      source: { type: 'tool-result', callId },
      content: [{ type: 'tool-result', content: [], isError }],
    },
  })
}

function diff(...paths: string[]): ToolResultNode['callView'] {
  return {
    card: 'diff', title: `Write ${paths[0] ?? ''}`,
    diffs: paths.map(path => ({ path, oldText: null, newText: 'x' })),
    locations: paths.map(path => ({ path })),
  }
}

function edit(path: string): ToolResultNode['callView'] {
  return { card: 'generic', title: `insert ${path}`, kind: 'edit', locations: [{ path }] }
}

function assembler(entries: readonly ConversationEventInput[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value
}

function deliverablesOf(value: ConversationNodeAssembler, turn = 1): Readonly<DeliverablesTurnData> | undefined {
  const snapshot = value.snapshot('test') as TimelineSnapshot
  return snapshot.timeline.turns.get(turn)?.data.get('deliverables')
}

describe('produced-file Turn data', () => {
  it('deduplicates paths in first-seen order and stops at the closing Assistant seq', () => {
    const data = produced(
      [3, 'out/index.html'],
      [4, 'out/app.css'],
      [4, 'out/index.html'],
      [8, 'after.txt'],
    )
    expect(producedForClosing(data, 6)).toEqual(['out/index.html', 'out/app.css'])
    expect(selectProducedFiles(tailOwner(data, 6))).toEqual(['out/index.html', 'out/app.css'])
    expect(producedForClosing(undefined)).toEqual([])
    expect(selectProducedFiles(tailOwner(undefined, 9, () => {}, 2))).toBeNull()
  })

  it('folds successful diff and generic-edit calls while ignoring reads, failures, and missing locations', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', diff('out/index.html', 'out/app.css')),
      result(3, 'write'),
      call(4, 'edit', edit('notes.md')),
      result(5, 'edit'),
      call(6, 'read', { card: 'generic', title: 'Read', locations: [{ path: 'input.txt' }] }),
      result(7, 'read'),
      call(8, 'failed', diff('broken.txt')),
      result(9, 'failed', true),
      call(10, 'locationless', { card: 'diff', title: 'Write', diffs: [] }),
      result(11, 'locationless'),
    ])

    expect(producedForClosing(deliverablesOf(value))).toEqual([
      'out/index.html', 'out/app.css', 'notes.md',
    ])
  })

  it('ignores calls without mutation locations, orphan results, and replacement results', () => {
    const replacement = result(8, 'replacement')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'no-view', name: 'fixture', arguments: '{}' }),
      result(3, 'no-view'),
      call(4, 'locationless-edit', { card: 'generic', title: 'Edit', kind: 'edit' }),
      result(5, 'locationless-edit'),
      result(6, 'orphan'),
      call(7, 'replacement', diff('replaced.txt')),
      {
        ...replacement,
        event: {
          ...replacement.event,
          surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
        } as ConversationEventInput['event'],
      },
      at(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    expect(producedForClosing(deliverablesOf(value))).toEqual([])
  })

  it('rejects an invalid start match and preserves state for an unrelated update', () => {
    const startMatch = matched(at(1, 'turn/start', { turn: 1 }), 'start')
    const emptyContext: Parameters<typeof deliverablesDefinition.start>[0] = {
      key: 'deliverables:1',
      kind: 'deliverables',
      id: '1',
      matches: [startMatch],
      start: startMatch,
      state: undefined,
      current: new Map(),
    }
    const reader: Parameters<typeof deliverablesDefinition.start>[2] = { previous: () => undefined }
    const state = deliverablesDefinition.start(emptyContext, startMatch, reader)
    const unrelated = matched(at(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), 'update')
    const context: Parameters<typeof deliverablesDefinition.update>[0] = { ...emptyContext, state }

    expect(() => deliverablesDefinition.start(emptyContext, unrelated, reader))
      .toThrow('deliverables start requires turn/start')
    expect(deliverablesDefinition.update(context, unrelated)).toBe(state)
  })

  it('keeps Turn data identity while produced paths are unchanged', () => {
    const startMatch = matched(at(1, 'turn/start', { turn: 1 }), 'start')
    const build = deliverablesDefinition.buildLocationData?.bind(deliverablesDefinition)
    if (build === undefined) throw new Error('deliverables publishes Turn data')
    const produced = [{ seq: 2, path: 'a.ts' }]
    const context: Parameters<typeof build>[0] = {
      key: 'deliverables:1',
      kind: 'deliverables',
      id: '1',
      matches: [startMatch],
      start: startMatch,
      state: { turn: 1, calls: new Map(), produced },
      current: new Map(),
    }
    const first = build(context, 'turn', null)
    expect(first).toEqual({ kind: 'turn', turn: 1, key: 'deliverables', value: { produced } })

    expect(build(context, 'turn', first)).toBe(first)
    expect(build({ ...context, state: undefined }, 'turn', first)).toBeNull()
    expect(build(context, 'step', first)).toBeNull()

    const grownPaths = [...produced, { seq: 3, path: 'b.ts' }]
    const second = build({ ...context, state: { turn: 1, calls: new Map(), produced: grownPaths } }, 'turn', first)
    expect(second).not.toBe(first)
    expect(second).toEqual({ kind: 'turn', turn: 1, key: 'deliverables', value: { produced: grownPaths } })
  })

  it('replays a tail page once prepend supplies its missing Turn start', () => {
    const value = assembler([
      call(10, 'late', diff('history.txt')),
      result(11, 'late'),
    ], true)
    expect(deliverablesOf(value)).toBeUndefined()

    value.prepend([at(1, 'turn/start', { turn: 1 })], false)
    value.flush()
    expect(producedForClosing(deliverablesOf(value))).toEqual(['history.txt'])
  })

  it('extends the same Turn data incrementally on live append', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'first', diff('first.txt')),
      result(3, 'first'),
    ])
    const first = deliverablesOf(value)
    expect(producedForClosing(first)).toEqual(['first.txt'])

    value.append(call(4, 'second', diff('second.txt')))
    value.append(result(5, 'second'))
    value.flush()
    expect(producedForClosing(deliverablesOf(value))).toEqual(['first.txt', 'second.txt'])
  })
})

describe('ProducedFiles row', () => {
  const t = makeTranslate(zh)
  const capability = (
    canOpenPath: boolean | undefined,
    isLoopback = true,
  ): Pick<ProducedFilesProps, 'isLoopback' | 'useHostDescription'> => {
    const description = canOpenPath === undefined
      ? undefined
      : { version: 'test', cwd: '/workspace', attachedSessions: 1, home: '/h', canOpenPath }
    return {
      isLoopback,
      useHostDescription: selector => selector(description),
    }
  }

  it('renders the bounded CSS candidates and opens a file or the workspace folder', () => {
    const paths = ['deep/a.html', 'b.css', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts']
    const openFile = vi.fn<(path: string) => void>()

    const view = render(
      <ProducedFiles matched={paths} openFile={openFile} {...capability(true)} t={t} />,
    )
    expect(view.getByText('产物')).toBeTruthy()
    const row = view.container.querySelector('[data-produced-files-row]')
    if (!(row instanceof HTMLElement)) throw new Error('produced row missing')
    expect(within(row).getAllByRole('button')).toHaveLength(6)
    expect(within(row).getByText('+ 2 个文件')).toBeTruthy()
    const chip = view.getByRole('button', { name: '打开 deep/a.html' })
    expect(chip.textContent).toBe('a.html')
    expect(chip.getAttribute('title')).toBe('deep/a.html')
    expect(view.queryByRole('button', { name: '打开 g.ts' })).toBeNull()
    fireEvent.click(chip)
    expect(openFile).toHaveBeenCalledWith('deep/a.html')

    const showFolder = view.getByRole('button', { name: '在文件夹中显示' })
    fireEvent.click(showFolder)
    expect(openFile).toHaveBeenLastCalledWith('.')
  })

  it('keeps the folder action absent without overflow or a local native opener', () => {
    const openFile = vi.fn<(path: string) => void>()
    const view = render(
      <ProducedFiles matched={['a.md']} openFile={openFile} {...capability(true)} t={t} />,
    )
    const overflowing = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md']
    expect(view.queryByRole('button', { name: '在文件夹中显示' })).toBeNull()
    for (const unavailable of [capability(false), capability(true, false), capability(undefined)]) {
      view.rerender(<ProducedFiles matched={overflowing} openFile={openFile} {...unavailable} t={t} />)
      expect(view.queryByRole('button', { name: '在文件夹中显示' })).toBeNull()
    }
  })

  it('uses singular English copy when exactly one file is hidden', () => {
    const view = render(
      <ProducedFiles
        matched={['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md']}
        openFile={() => {}}
        {...capability(false)}
        t={makeTranslate(en)}
      />,
    )
    const row = view.container.querySelector('[data-produced-files-row]')
    if (!(row instanceof HTMLElement)) throw new Error('produced row missing')
    expect(within(row).getByText('+ 1 file')).toBeTruthy()
  })
})

describe('producedFileMentions resolver', () => {
  const label = (path: string) => `打开 ${path}`

  it('resolves exact paths and unique basenames; ambiguity and unknowns stay unresolved', () => {
    const opened: string[] = []
    const resolver = producedFileMentions(
      ['out/index.html', 'a/style.css', 'b/style.css'],
      (path) => { opened.push(path) },
      label,
    )
    // Unique basename resolves to its full path; the full path rides title.
    const byBasename = resolver.resolve('index.html')
    expect(byBasename?.label).toBe('打开 out/index.html')
    expect(byBasename?.title).toBe('out/index.html')
    byBasename?.open()
    expect(opened).toEqual(['out/index.html'])
    // An exact path resolves even when its basename is ambiguous.
    const exact = resolver.resolve('a/style.css')
    expect(exact?.title).toBe('a/style.css')
    // A basename two paths share stays unresolved rather than guessing,
    // and so does a token naming nothing the turn wrote.
    expect(resolver.resolve('style.css')).toBeUndefined()
    expect(resolver.resolve('notes.md')).toBeUndefined()
    expect(basename('a\\b\\c.txt')).toBe('c.txt')
  })
})

describe('plugin registration', () => {
  it('reads on the retained project connection and drops private caches when the Session is released', async () => {
    const ctx = new Context()
    const scope = new Context()
    let retained = true
    const sessionId = SessionId('project-review')
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin(ConversationEventRegistry).await()
    ctx.slots.register({ name: 'root', children: { 'conversation.chat.turnTail': { kind: 'chain', scope: 'session' } } } as never, () => null)
    const summary = vi.fn(async () => ({ result: { ok: true, value: { turn: 1, files: [], total: 0, added: 0, deleted: 0 } } }))
    const baseSummary = vi.fn()
    const target = { kind: 'project', projectId: 7 }
    const hostDescription = createSnapshotStore({ executionAuthorityRequired: false, canOpenPath: true })
    const project = { api: { workspaceChanges: { summary } }, hostDescription, isLoopback: true }
    const forTarget = vi.fn(() => project)
    ctx.provide('connection', { api: { settings: {}, workspaceChanges: { summary: baseSummary } }, hostDescription, isLoopback: true, forTarget } as never)
    ctx.provide('sessions', { scope: () => retained ? scope : undefined, runtimeTargetFor: () => target } as never)
    ctx.provide('sidebarRight', { openSessionResource: vi.fn() } as never)
    ctx.provide('sidebarRightTabs', { register: () => () => {} } as never)
    ctx.provide('remote', { $on: () => () => {} } as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    try {
      await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
      await ctx.plugin({ inject: [...inject], apply }).await()
      const entry = ctx.slots.entries('conversation.chat.turnTail').find(item => item.select === selectDeliverables)!
      const face = entry.inject!(sessionId as never) as unknown as DeliverablesInjected
      forTarget.mockReturnValueOnce(undefined as never)
      expect(() => entry.inject!(SessionId('missing-runtime') as never)).toThrow('runtime is unavailable')
      await face.loadChangesSummary(sessionId, 5)
      expect(forTarget).toHaveBeenCalledWith(target)
      expect(summary).toHaveBeenCalledWith({ sessionId, seq: 5 }, expect.any(AbortSignal))
      expect(baseSummary).not.toHaveBeenCalled()
      await face.reloadPresentedHost()
      expect(face.hooks.presentedHost.getSnapshot()).toMatchObject({ available: false })
      await face.loadChangesSummary(SessionId('foreign'), 5)
      expect(summary).toHaveBeenCalledOnce()
      expect(() =>{  face.openChangesReview({ sessionId: SessionId('foreign'), seq: 5, turn: 1 }, 0) }).toThrow('another Session')
      ctx.emit('connection/reset')
      expect(face.hooks.changesSummary.getSnapshot()).toEqual({})
      await face.loadChangesSummary(sessionId, 5)
      retained = false
      await scope.fiber.dispose()
      expect(face.hooks.changesSummary.getSnapshot()).toEqual({})
      expect(face.hooks.presentedHost.getSnapshot()).toBeNull()
      expect(() => entry.inject!(sessionId as never)).toThrow('retained Session')
    } finally {
      await scope.fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('serves both sidebar and turn-tail readers through local RPC and checks current desktop authority', async () => {
    const ctx = new Context()
    const sessionId = SessionId('local-review')
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin(ConversationEventRegistry).await()
    ctx.slots.register({ name: 'root', children: {
      'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    } } as never, () => null)
    const summary = vi.fn().mockResolvedValue({ result: { ok: true, value: { turn: 1, files: [], total: 0, added: 0, deleted: 0 } } })
    const diff = vi.fn().mockResolvedValue({ result: { ok: true, value: { kind: 'binary', path: 'a.bin', display: 'a.bin' } } })
    const openPath = vi.fn().mockResolvedValue({ result: { ok: true, value: null } })
    const hostDescription = createSnapshotStore<{ executionAuthorityRequired?: boolean; canOpenPath?: boolean } | undefined>(undefined)
    const connection = { api: { settings: {}, host: { openPath }, workspaceChanges: { summary, diff } }, hostDescription, isLoopback: true }
    const list = createSnapshotStore({ byId: { [sessionId]: { cwd: '/work' } } })
    ctx.provide('connection', connection as never)
    ctx.provide('sessions', { scope: () => ctx, list } as never)
    const navigate = vi.fn()
    ctx.provide('sidebarRight', { openSessionResource: navigate } as never)
    ctx.provide('sidebarRightTabs', { register: () => () => {} } as never)
    ctx.provide('remote', { $on: () => () => {} } as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    try {
      await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      const entry = ctx.slots.entries('conversation.chat.turnTail').find(item => item.select === selectDeliverables)!
      const face = entry.inject!(sessionId as never) as unknown as DeliverablesInjected
      const tab = ctx.slots.entries('sidebar.right.pane.tab')[0]!.inject!(sessionId as never) as unknown as ReviewInjected
      expect(tab.hooks.changesSummary).toBe(face.hooks.changesSummary)
      expect(ctx.slots.entries('tool.call.toolview')).toHaveLength(1)
      await face.loadChangesSummary(sessionId, 1)
      await tab.loadChangesSummary(sessionId, 1)
      expect(summary).toHaveBeenCalledOnce()
      summary.mockResolvedValueOnce({ result: { ok: false, error: { code: 'forbidden' } } })
      await face.loadChangesSummary(sessionId, 2)
      expect(face.hooks.changesSummary.getSnapshot()[changesSummaryUrl(sessionId, 2)]).toBe('missing')
      summary.mockResolvedValueOnce({ result: { ok: true, value: null } })
      await face.loadChangesSummary(sessionId, 3)
      expect(face.hooks.changesSummary.getSnapshot()[changesSummaryUrl(sessionId, 3)]).toBe('missing')
      await tab.loadChangesDiff(sessionId, 1, 0)
      expect(diff).toHaveBeenCalledWith({ sessionId, seq: 1, index: 0 }, expect.any(AbortSignal))
      expect(tab.hooks.changesDiff.getSnapshot()[changesDiffUrl(sessionId, 1, 0)]).toMatchObject({ kind: 'binary' })
      diff.mockResolvedValueOnce({ result: { ok: false, error: { code: 'forbidden' } } })
      await tab.loadChangesDiff(sessionId, 1, 1)
      expect(tab.hooks.changesDiff.getSnapshot()[changesDiffUrl(sessionId, 1, 1)]).toBe('error')
      face.openChangesReview({ sessionId, seq: 1, turn: 1 }, 0)
      expect(navigate).toHaveBeenCalledWith(sessionId, changesReviewAddress({ sessionId, seq: 1, turn: 1 }), { params: { index: 0 } })
      await tab.reloadPresentedHost()
      expect(tab.hooks.presentedHost.getSnapshot()).toMatchObject({ available: false })
      hostDescription.set({ executionAuthorityRequired: false, canOpenPath: true })
      expect(tab.hooks.presentedHost.getSnapshot()).toBeNull()
      await face.reloadPresentedHost()
      expect(tab.hooks.presentedHost.getSnapshot()).toMatchObject({ available: true })
      await face.openPresented(sessionId, 1, 0, 'open', 'report.txt')
      expect(openPath).toHaveBeenLastCalledWith({ path: '/work/report.txt' }, expect.any(AbortSignal))
      await face.openPresented(sessionId, 1, 0, 'reveal', 'report.txt')
      expect(openPath).toHaveBeenLastCalledWith({ path: '/work/' }, expect.any(AbortSignal))
      await tab.openChanged(sessionId, 1, 0, '/work/report.txt')
      await face.openChanged(sessionId, 1, 0, '/work/report.txt')
      openPath.mockResolvedValueOnce({ result: { ok: false, error: { code: 'forbidden' } } })
      await face.openPresented(sessionId, 1, 0, 'open', 'report.txt')
      expect(face.hooks.presentedOpen.getSnapshot()['/api/present.open?sessionId=local-review&seq=1&index=0']).toBe('error')
      list.set({ byId: {} })
      const beforeUnknownWorkspace = openPath.mock.calls.length
      await face.openPresented(sessionId, 1, 0, 'open', 'report.txt')
      expect(openPath).toHaveBeenCalledTimes(beforeUnknownWorkspace)
      expect(face.hooks.presentedOpen.getSnapshot()['/api/present.open?sessionId=local-review&seq=1&index=0']).toBe('error')
      hostDescription.set({ executionAuthorityRequired: true, canOpenPath: true })
      const calls = openPath.mock.calls.length
      await face.openPresented(sessionId, 1, 0, 'open', 'report.txt')
      expect(openPath).toHaveBeenCalledTimes(calls)
      await fiber.dispose()
      expect(face.hooks.changesSummary.getSnapshot()).toEqual({})
      expect(tab.hooks.changesDiff.getSnapshot()).toEqual({})
    } finally { await ctx.fiber.dispose() }
  })

  it('registers the tail entry and fiber disposal removes it', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin(ConversationEventRegistry).await()
    // The owning view's child declaration, stood up by a bench root entry.
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.turnTail': { kind: 'chain', scope: 'session' } },
    } as never, () => null)
    const hostDescription = { getSnapshot: () => undefined, subscribe: () => () => {} }
    ctx.provide('connection', {
      api: { settings: {} },
      isLoopback: false,
      hostDescription,
    } as never)
    // ui-theme's Appearance row binds a durable scope through these two.
    ctx.provide('sessions', { scope: () => ctx } as never)
    ctx.provide('sidebarRight', { openResource: vi.fn() } as never)
    ctx.provide('sidebarRightTabs', { register: () => () => {} } as never)
    ctx.provide('remote', { $on: () => () => {} } as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [entry] = ctx.slots.entries('conversation.chat.turnTail')
    expect(entry).toBeDefined()
    expect(entry?.inject?.()).toEqual({ isLoopback: false, hooks: { hostDescription } })
    expect(entry?.select?.(tailOwner(produced([2, 'fallback.txt']), 3) as never)).toEqual(['fallback.txt'])
    expect(entry?.select?.(tailOwner({ produced: [], changes: { seq: 2 } }, 3) as never)).toBeNull()
    expect(entry?.select?.(tailOwner({ produced: [], presented: [{ path: 'delivery.txt', seq: 2, index: 0 }] }, 3) as never)).toBeNull()


    // The prose face is live while the plugin is: a produced turn yields a
    // resolver whose matches open through the owner-supplied opener.
    const opened: string[] = []
    const owner = tailOwner(
      produced([2, 'site/report.html']),
      3,
      (path) => { opened.push(path) },
    )
    const service = (ctx as unknown as { get(name: string): ChatFileMentions | undefined }).get('chatFileMentions')
    const mentions = service?.forClosing(owner)
    mentions?.resolve('report.html')?.open()
    expect(opened).toEqual(['site/report.html'])
    // A turn that produced nothing yields no vocabulary at all.
    expect(service?.forClosing(tailOwner(undefined, 2))).toBeUndefined()
    const declared = service?.forClosing(tailOwner({ produced: [], presented: [{ path: 'delivered.txt', seq: 2, index: 0 }] }, 3,
      (path) => { opened.push(path) }))
    declared?.resolve('delivered.txt')?.open()
    expect(opened).toEqual(['site/report.html', 'delivered.txt'])


    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    // Fiber teardown retracts the service: the consumer's ctx.get sees the off state.
    expect((ctx as unknown as { get(name: string): unknown }).get('chatFileMentions')).toBeUndefined()
  })
})

function openProps(controller = new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {}), summaries = new ChangesSummaryStore((url, signal) => fetch(url, { signal }))) {
  controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
  const sessions: SessionListState = { current: undefined, currentAddress: undefined, ids: [], byId: {}, archivedById: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {} }
  return {
    useSessions: <T,>(select: (state: SessionListState) => T): T => select(sessions),
    reloadPresentedHost: vi.fn(() => controller.loadHost()),
    useChangesSummary: <T,>(select: (state: ReturnType<typeof summaries.state.getSnapshot>) => T): T =>
      select(summaries.state.getSnapshot()),
    loadChangesSummary: vi.fn((...args: Parameters<ChangesSummaryStore['load']>) => summaries.load(...args)),
    usePresentedHost: <T,>(select: (state: ReturnType<typeof controller.host.getSnapshot>) => T): T =>
      select(controller.host.getSnapshot()),
    openPresented: vi.fn((...args: Parameters<PresentedOpenController['open']>) => controller.open(...args)),
    openChanged: vi.fn((...args: Parameters<PresentedOpenController['openChanged']>) => controller.openChanged(...args)),
    openChangesReview: vi.fn<DeliverablesInjected['openChangesReview']>(),
    usePresentedOpen: <T,>(select: (state: ReturnType<typeof controller.state.getSnapshot>) => T): T =>
      select(controller.state.getSnapshot()),
  }
}
const changedFile = (display: string, added = 1, deleted = 0, extra: { binary?: true; oversized?: true; path?: string } = {}) =>
  ({
    path: extra.path ?? display, display, added, deleted,
    ...extra.binary === true ? { binary: true as const } : {},
    ...extra.oversized === true ? { oversized: true as const } : {},
  })

const changesEvent = (seq: number, turn = 1) => at(seq, 'workspace/changes', { turn })

describe('announced changes Turn data', () => {
  it('keeps the latest valid announcement of the turn and ignores malformed ones', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      changesEvent(2),
      at(3, 'workspace/changes', { turn: 'x' }),
      at(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      changesEvent(5),
      at(6, 'turn/start', { turn: 2 }),
    ])
    const owner = tailOwner(deliverablesOf(value), 4)
    expect(changesForClosing(owner)).toEqual({ seq: 5 })
    expect(selectDeliverables(owner)).toEqual({ changes: { seq: 5 }, presented: [] })
    expect(changesForClosing(tailOwner(deliverablesOf(value, 2), 8))).toBeNull()
    expect(selectDeliverables(tailOwner(deliverablesOf(value, 2), 8))).toBeNull()
    expect(changesForClosing(tailOwner(undefined, 8))).toBeNull()
  })

  it('preserves Turn data identity across unrelated appends', () => {
    const value = assembler([at(1, 'turn/start', { turn: 1 }), changesEvent(2)])
    const first = deliverablesOf(value)
    value.append(at(3, 'unrelated/event', {}))
    value.flush()
    expect(deliverablesOf(value)).toBe(first)
  })
})

describe('ChangedFiles card', () => {
  const files = [
    changedFile('config/design-token', 42, 11), changedFile('config/feature-flags.json', 143, 32),
    changedFile('config/launch-plan.yaml', 654, 9), changedFile('src/index.ts', 393, 274),
    changedFile('~/.zshrc', 0, 0, { binary: true, path: '/home/u/.zshrc' }),
  ]
  const changes = { seq: 5 }
  const served: ChangesSummary = { turn: 1, files, total: 11, added: 1232, deleted: 326 }

  /** A store already holding the summary the Host served for the announced sequence. */
  function servedStore(summary: ChangesSummary = served, seq = 5) {
    const summaries = new ChangesSummaryStore((url, signal) => fetch(url, { signal }))
    summaries.state.set({ [changesSummaryUrl(SessionId('child-session'), seq)]: summary })
    return summaries
  }

  function renderCard(
    controller = new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {}), locale = en, matched = { changes, presented: [] as never[] }, summaries = servedStore(),
  ) {
    const props = openProps(controller, summaries)
    props.openChanged.mockResolvedValue(undefined)
    const openFile = vi.fn<(path: string) => void>()
    const view = render(<Deliverables {...props} matched={matched} openFile={openFile} sessionId={SessionId('child-session')} t={makeTranslate(locale)} />)
    return { props, openFile, view }
  }

  it('reads the announced summary once and renders nothing while it loads, when it is gone, or when it lists no file', async () => {
    const summaries = new ChangesSummaryStore((url, signal) => fetch(url, { signal }))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('seq=5')) return Response.json(served)
      if (url.endsWith('seq=6')) return Response.json({ turn: 1, files: [], total: 0, added: 0, deleted: 0 })
      return new Response('gone', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { props, view } = renderCard(new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {}), en, { changes, presented: [] as never[] }, summaries)
    expect(view.container.querySelector('[data-changed-files]')).toBeNull()
    expect(props.loadChangesSummary).toHaveBeenCalledWith('child-session', 5)
    await vi.waitFor(() => { expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 5)]).toEqual(served) })
    view.rerender(<Deliverables {...props} matched={{ changes, presented: [] }} openFile={() => {}} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
    expect(view.getByText('Edited 11 files')).toBeTruthy()
    for (const seq of [6, 7]) {
      view.rerender(<Deliverables {...props} matched={{ changes: { seq }, presented: [] }} openFile={() => {}} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
      await vi.waitFor(() => { expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), seq)]).not.toBe('loading') })
      view.rerender(<Deliverables {...props} matched={{ changes: { seq }, presented: [] }} openFile={() => {}} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
      expect(view.container.querySelector('[data-changed-files]')).toBeNull()
    }
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 7)]).toBe('missing')
    await summaries.load(SessionId('child-session'), 5)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // A replaced connection forgets every read; a later mount asks the new Host again.
    summaries.reset()
    expect(summaries.state.getSnapshot()).toEqual({})
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await summaries.load(SessionId('child-session'), 5)
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 5)]).toBe('missing')
    fetchMock.mockResolvedValueOnce(Response.json({ turn: 'x' }))
    await summaries.load(SessionId('child-session'), 8)
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 8)]).toBe('missing')
    await summaries.dispose()
    await summaries.load(SessionId('child-session'), 9)
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 9)]).toBeUndefined()
  })

  it('sums the header from the Host totals, not from the capped list', () => {
    const capped = servedStore({ turn: 1, files: files.slice(0, 1), total: 2, added: 50, deleted: 20 })
    const { view } = renderCard(new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {}), en, { changes, presented: [] as never[] }, capped)
    expect(view.getByText('Edited 2 files')).toBeTruthy()
    expect(view.getByText('+50')).toBeTruthy()
    expect(view.getByText('-20')).toBeTruthy()
  })

  it('lets no read started before a reset publish afterwards', async () => {
    const summaries = new ChangesSummaryStore((url, signal) => fetch(url, { signal }))
    let settle!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const stale = summaries.load(SessionId('child-session'), 5)
    summaries.reset()
    const url = changesSummaryUrl(SessionId('child-session'), 5)
    expect(summaries.state.getSnapshot()[url]).toBeUndefined()
    settle(Response.json(served))
    await stale
    // The reset abandoned the read; a later mount asks the new Host afresh.
    expect(summaries.state.getSnapshot()[url]).toBeUndefined()
    await summaries.dispose()
  })

  it('drops a read that settles after disposal', async () => {
    const summaries = new ChangesSummaryStore((url, signal) => fetch(url, { signal }))
    let settle!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const loading = summaries.load(SessionId('child-session'), 5)
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 5)]).toBe('loading')
    const disposal = summaries.dispose()
    settle(Response.json(served))
    await Promise.all([loading, disposal])
    expect(summaries.state.getSnapshot()).toEqual({})
  })

  it('summarizes the turn, folds after three rows, and opens the review from the header and each row', () => {
    const { props, openFile, view } = renderCard()
    const card = view.container.querySelector('[data-changed-files]')
    if (!(card instanceof HTMLElement)) throw new Error('changed-files card missing')
    expect(within(card).getByText('Edited 11 files')).toBeTruthy()
    expect(within(card).getByText('+1,232')).toBeTruthy()
    expect(within(card).getByText('-326')).toBeTruthy()
    expect(within(card).getAllByRole('listitem')).toHaveLength(3)
    expect(within(card).getByText('config/design-token')).toBeTruthy()
    expect(within(card).getByText('+42')).toBeTruthy()
    expect(within(card).queryByText('src/index.ts')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'View changes to config/feature-flags.json' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 1)
    expect(props.openChanged).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: 'Review this turn’s changes in the sidebar' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 0)
    expect(openFile).not.toHaveBeenCalled()
    const expand = within(card).getByRole('button', { name: 'Show all 5 changed files' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expect(expand.textContent).toContain('All 5 files')
    fireEvent.click(expand)
    expect(within(card).getAllByRole('listitem')).toHaveLength(5)
    expect(within(card).getByText('binary')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'View changes to ~/.zshrc' }).getAttribute('title')).toBe('/home/u/.zshrc')
    fireEvent.click(within(card).getByRole('button', { name: 'View changes to ~/.zshrc' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 4)
    const collapse = within(card).getByRole('button', { name: 'Collapse changed files' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(card.lastElementChild).toBe(collapse)
    fireEvent.click(collapse)
    expect(within(card).getAllByRole('listitem')).toHaveLength(3)
  })

  it('opens the review the same way without a desktop', () => {
    const controller = new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {})
    const { openFile, props, view } = renderCard(controller, zh)
    controller.host.set('error')
    view.rerender(<Deliverables {...props} matched={{ changes, presented: [] }} openFile={openFile} sessionId={SessionId('child-session')} t={makeTranslate(zh)} />)
    expect(view.getByRole('button', { name: '在侧边栏查看本轮改动' })).toBeTruthy()
    controller.host.set({ name: 'server', available: false, fileManager: null })
    view.rerender(<Deliverables {...props} matched={{ changes, presented: [] }} openFile={openFile} sessionId={SessionId('child-session')} t={makeTranslate(zh)} />)
    expect(view.getByText('已编辑 11 个文件')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '在侧边栏查看本轮改动' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 0)
    fireEvent.click(view.getByRole('button', { name: '查看 config/design-token 的改动' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 0)
    expect(openFile).not.toHaveBeenCalled()
    expect(props.openChanged).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: '展开全部 5 个改动文件' }).textContent).toContain('全部 5 个文件')
  })

  it('keeps every count in place whatever the native-open gestures of the review tab are doing', () => {
    const controller = new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {})
    controller.state.set({
      '/api/changes.open?sessionId=child-session&seq=5&index=0': 'opening',
      '/api/changes.open?sessionId=child-session&seq=5&index=1': 'error',
    })
    const { view } = renderCard(controller)
    // Native-open gestures belong to the review tab; the card shows counts only.
    expect(view.queryByText(en['presented.opening'])).toBeNull()
    expect(view.queryByText(en['presented.error'])).toBeNull()
    expect(view.getByText('+42')).toBeTruthy()
    expect(view.getByText('+143')).toBeTruthy()
    expect(view.getByText('+1,232')).toBeTruthy()
  })

  it('renders without a fold for three files or fewer and beside delivery cards', () => {
    const short = servedStore({ turn: 1, files: [...files.slice(0, 1), changedFile('huge.bin', 0, 0, { oversized: true })], total: 2, added: 185, deleted: 43 })
    const { view } = renderCard(new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {}), en, { changes, presented: [{ path: 'report.pdf', seq: 6, index: 0 }] as never[] }, short)
    expect(view.getByText('Edited 2 files')).toBeTruthy()
    expect(view.getByText('too large')).toBeTruthy()
    expect(view.queryByRole('button', { name: /Show all|Collapse changed/ })).toBeNull()
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(1)
    expect(view.container.querySelector('[data-presented-files-row]')?.parentElement?.getAttribute('data-after-changes')).toBe('true')
  })
})


describe('explicit delivery events', () => {
  const file = (path = 'report.docx') => ({ path })
  it('ignores delivery events whose file list contains no valid declaration', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'deliverables/presented', { turn: 1, callId: 'empty', files: [null, {}, { path: ' ' }] }),
    ])
    expect(presentedForClosing(tailOwner(deliverablesOf(value), 3))).toEqual([])
  })

  it('replays deliveries without mutation calls, preserves indices, and isolates turns', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'deliverables/presented', { turn: 1, callId: 'nested', files: [null, { ...file(), description: 'Final report' }] }),
      at(3, 'deliverables/presented', { turn: 1, callId: 'again', files: [{ ...file(), description: 'Updated report' }] }),
      at(4, 'turn/end', { turn: 1 }),
      at(5, 'turn/start', { turn: 2 }),
    ])
    const first = presentedForClosing(tailOwner(deliverablesOf(value), 3))
    expect(first).toMatchObject([{ path: 'report.docx', seq: 2, index: 1, description: 'Final report' }])
    expect(presentedForClosing(tailOwner(deliverablesOf(value), 4)))
      .toMatchObject([{ path: 'report.docx', seq: 3, description: 'Updated report' }])
    expect(selectDeliverables(tailOwner(deliverablesOf(value, 2), 9))).toBeNull()
  })

})

describe('delivery card interactions', () => {
  const file = (path = 'report.docx') => ({ path })
  it('uses the viewed fork Session in every open action and expands all delivered files', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'deliverables/presented', { turn: 1, callId: 'nested', files: Array.from({ length: 8 }, (_, i) => file(`report-${i}.docx`)) }),
    ])
    const preview = vi.fn()
    const owner = tailOwner(deliverablesOf(value), 3, preview)
    const matched = selectDeliverables(owner)!
    const props = openProps()
    props.openPresented.mockResolvedValue(undefined)
    const view = render(<Deliverables {...props} matched={matched} openFile={owner.openFile} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(4)
    const expand = view.getByRole('button', { name: 'Show all 8 delivered files' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(8)
    expect(view.getByRole('button', { name: 'Collapse delivered files' }).getAttribute('aria-expanded')).toBe('true')
    expect(view.queryByRole('link')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Preview report-0.docx in sidebar' }))
    fireEvent.click(view.getByRole('button', { name: 'Open report-0.docx in sidebar' }))
    expect(preview).toHaveBeenCalledTimes(2)
    expect(preview).toHaveBeenLastCalledWith('report-0.docx')
    fireEvent.click(view.getByRole('button', { name: 'More file actions for report-0.docx' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Open in default app' }))
    expect(props.openPresented).toHaveBeenCalledWith('child-session', 2, 0, 'open', 'report-0.docx')
    fireEvent.click(view.getByRole('button', { name: 'Collapse delivered files' }))
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(4)
    expect(view.container.querySelector('[data-changed-files]')).toBeNull()
  })
})

it.each([null, [], 'invalid'])('declines non-object delivery data: %j', (data) => {
  expect(deliverablesDefinition.match(at(1, 'deliverables/presented', data).event)).toBeNull()
})

it.each([{}, { turn: '1', callId: 'bad', files: [] },
  { turn: 1.5, callId: 'bad', files: [] }, { turn: 0, callId: 'bad', files: [] },
  { turn: 1, files: [] }, { turn: 1, callId: '', files: [] }, { turn: 1, callId: 'bad', files: null },
])('ignores malformed delivery data and keeps the recorded changes card: %j', (data) => {
  const value = assembler([
    at(1, 'turn/start', { turn: 1 }),
    call(2, 'write-a', diff('a.txt')),
    result(3, 'write-a'),
    at(4, 'deliverables/presented', data),
    at(5, 'workspace/changes', { turn: 1 }),
  ])
  const owner = tailOwner(deliverablesOf(value), 6)
  const matched = selectDeliverables(owner)!
  const summaries = new ChangesSummaryStore((url, signal) => fetch(url, { signal }))
  summaries.state.set({ [changesSummaryUrl(SessionId('session'), 5)]: { turn: 1, files: [{ path: 'a.txt', display: 'a.txt', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 } })
  const view = render(<Deliverables {...openProps(new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {}), summaries)} matched={matched} openFile={owner.openFile} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText('Edited 1 files')).toBeTruthy()
  expect(view.queryByText('Deliverables')).toBeNull()
})

it('shows descriptions and falls back to file metadata without hiding extensionless deliveries', () => {
  const view = render(<Deliverables {...openProps()} matched={{ changes: null, presented: [
    { path: 'out/report.txt', description: 'Quarterly summary', seq: 2, index: 0 },
    { path: 'LICENSE', seq: 2, index: 1 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText('Quarterly summary')).toBeTruthy()
  expect(view.getByText('File')).toBeTruthy()
  expect(view.getByTitle('out/report.txt')).toBeTruthy()
  expect(view.getByText('report.txt')).toBeTruthy()
})

it('distinguishes PDF, Word, Markdown, and code files with compact decorative card icons', () => {
  const paths = ['report.pdf', 'report.docx', 'README.md', 'index.tsx']
  const view = render(<Deliverables {...openProps()} matched={{ changes: null, presented:
    paths.map((path, index) => ({ path, seq: 2, index })),
  }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  const icons = [...view.container.querySelectorAll('[data-presented-file]')].map((card) => {
    const icon = card.querySelector('svg')!
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.getAttribute('width')).toBe('20')
    return icon.innerHTML
  })
  expect(new Set(icons).size).toBe(paths.length)
})

it('lets one delivered file span the complete row without an expansion control', () => {
  const view = render(<Deliverables {...openProps()} matched={{ changes: null, presented: [
    { path: 'report.pdf', seq: 2, index: 0 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.container.querySelector('[data-presented-files-row]')?.getAttribute('data-single')).toBe('true')
  expect(view.queryByRole('button', { name: /delivered files/ })).toBeNull()
})


it.each(['opening', 'opened', 'error'] as const)('shows the %s state and permits retries after failure', (phase) => {
  const controller = new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {})
  controller.state.set({ '/api/present.open?sessionId=session&seq=2&index=0': phase })
  const props = openProps(controller)
  const view = render(<Deliverables {...props} matched={{ changes: null, presented: [
    { path: 'report.txt', seq: 2, index: 0 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText(en[`presented.${phase}`])).toBeTruthy()
  expect((view.getByRole('button', { name: 'More file actions for report.txt' }) as HTMLButtonElement).disabled).toBe(phase === 'opening')
})


it('explains a missing desktop and retries failed Host metadata', () => {
  const controller = new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {})
  const props = openProps(controller)
  const matched = { changes: null, presented: [{ path: 'file.txt', seq: 2, index: 0 }] }
  controller.host.set('error')
  const view = render(<Deliverables {...props} matched={matched} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  props.reloadPresentedHost.mockResolvedValue(undefined)
  fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  expect(props.reloadPresentedHost).toHaveBeenCalledOnce()
  controller.host.set({ name: 'server', available: false, fileManager: null })
  view.rerender(<Deliverables {...props} matched={matched} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText(en['presented.unavailable'])).toBeTruthy()
})


it('loads desktop information once the tail renders and not again while it is known', () => {
  const controller = new PresentedOpenController(() => ({ name: '', available: true, fileManager: 'directory' }), async () => {})
  const props = openProps(controller)
  controller.host.set(null)
  props.reloadPresentedHost.mockResolvedValue(undefined)
  const shared = { ...props, openFile: () => {}, sessionId: SessionId('session'), t: makeTranslate(en) }
  const view = render(<Deliverables {...shared} matched={{ changes: { seq: 2 }, presented: [] }} />)
  expect(props.reloadPresentedHost).toHaveBeenCalledOnce()
  controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
  view.rerender(<Deliverables {...shared} matched={{ changes: null, presented: [{ path: 'report.txt', seq: 2, index: 0 }] }} />)
  expect(props.reloadPresentedHost).toHaveBeenCalledOnce()
})

it('contributes file artifacts to the tail list only for turns with deliveries', () => {
  const owner = tailOwner(undefined, 3)
  const props = { ...openProps(), ...owner, sessionId: SessionId('session'), t: makeTranslate(en) } as unknown as Parameters<typeof DeliverablesTail>[0]
  const view = render(<DeliverablesTail {...props} />)
  expect(view.container.innerHTML).toBe('')
  const withFile = tailOwner({ produced: [], presented: [{ path: 'report.md', seq: 2, index: 0 }] }, 3)
  view.rerender(<DeliverablesTail {...props} {...withFile} />)
  expect(view.getByText('report.md')).toBeTruthy()
})
