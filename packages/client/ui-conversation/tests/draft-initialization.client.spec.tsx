// @vitest-environment jsdom
/**
 * Draft initialization: the `conversation/draft-initialize` root event the
 * New Session flow emits after navigation commits, applied through the input
 * hub and the per-session chat draft owner. Covers prefill, preserve, clear,
 * persistence ownership, and the submission-blocked refusal — a prefill never
 * sends.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  SlotTestRuntime, usePinnedBrowserLanguages, stubSettingsScope, stubDeveloperTools,
} from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createChatStore } from '../src/client/stores.ts'
import type { InputHub } from '../src/client/input/hub.ts'

usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId
const OTHER = 'other-1' as SessionId

type ChatInstance = ReturnType<ReturnType<typeof createChatStore>['create']>

const sessionFake = () => ({
  open: vi.fn(() => Promise.resolve()),
  loadOlder: vi.fn(() => Promise.resolve()),
  prompt: vi.fn<ISession['prompt']>(() => new Promise(() => {})),
  cancel: vi.fn<ISession['cancel']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
})

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', {
    api: { settings: {} }, isLoopback: false,
    hostDescription: { getSnapshot: () => undefined },
  })
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('remote.permissionPresets', { catalog: () => Promise.resolve({ ok: true, value: [] }) })
  const settingsScopeStub = stubSettingsScope()
  runtime.provide('settingsScope', { bind: () => settingsScopeStub.scope, developerTools: stubDeveloperTools().preference } as never)
  const prompt = sessionFake().prompt!
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session: { ...sessionFake(), prompt },
  })
  await runtime.sessions.add({
    id: OTHER,
    summary: { title: 'O', displayTitle: 'O', cwd: '/proj' },
    session: sessionFake(),
  })
  runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'details': { kind: 'single', scope: 'session' },
  }, () => null)
  await runtime.mount({ inject: [...inject], apply })
  runtime.renderRoot()
  const input = runtime.ctx.get('conversation')!.input as InputHub
  const chat = (id: SessionId) => runtime.storeOf('conversation.session', id) as ChatInstance
  const draft = (id: SessionId) => input.shell(id).snapshot.draft
  const actions = (id: SessionId) => input.shell(id).actions
  return { runtime, input, chat, draft, actions, prompt }
}

describe('draft initialization', () => {
  it('prefills an untouched Session through the durable chat owner without sending', async () => {
    const b = await bench()
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: OTHER, prompt: 'seed text' })
    expect(b.chat(OTHER).store.getSnapshot().draft).toBe('seed text')
    // The composer shell materializes later and is born holding the text —
    // initialization precedes the first input-model read.
    expect(b.draft(OTHER)).toBe('seed text')
    expect(b.prompt).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  it('preserves a nonempty stored draft unless clearing is explicit', async () => {
    const b = await bench()
    b.chat(OTHER).actions.setDraft('keep me')
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: OTHER, prompt: 'ignored' })
    expect(b.chat(OTHER).store.getSnapshot().draft).toBe('keep me')
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: OTHER, clearPreviousDraft: true })
    expect(b.chat(OTHER).store.getSnapshot().draft).toBe('')
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: OTHER, prompt: 'after clear', clearPreviousDraft: true })
    expect(b.chat(OTHER).store.getSnapshot().draft).toBe('after clear')
    expect(b.draft(OTHER)).toBe('after clear')
    await b.runtime.dispose()
  })

  it('applies to a live empty shell and syncs the durable owner', async () => {
    const b = await bench()
    expect(b.draft(ROOT)).toBe('')
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: ROOT, prompt: 'live prefill' })
    expect(b.draft(ROOT)).toBe('live prefill')
    expect(b.chat(ROOT).store.getSnapshot().draft).toBe('live prefill')
    await b.runtime.dispose()
  })

  it('preserves a live draft the user already typed', async () => {
    const b = await bench()
    b.actions(ROOT).setDraft('typed first')
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: ROOT, prompt: 'ignored' })
    expect(b.draft(ROOT)).toBe('typed first')
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: ROOT, prompt: 'replaced', clearPreviousDraft: true })
    expect(b.draft(ROOT)).toBe('replaced')
    expect(b.chat(ROOT).store.getSnapshot().draft).toBe('replaced')
    await b.runtime.dispose()
  })

  it('refuses while a submission owns the draft', async () => {
    const b = await bench()
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: ROOT, prompt: 'in flight' })
    b.actions(ROOT).submit()
    b.runtime.ctx.emit('conversation/draft-initialize', { sessionId: ROOT, prompt: 'too late', clearPreviousDraft: true })
    expect(b.draft(ROOT)).toBe('in flight')
    await b.runtime.dispose()
  })
})
