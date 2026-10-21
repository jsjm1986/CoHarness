// @vitest-environment jsdom
/** WelcomeNotice behavior: versioned preview acknowledgement over the
 * settings scope, modal chrome, and copy identity in both locales. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/src/client/schema.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsScopeController } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-scope.ts'
import { WelcomeNotice } from '../src/client/WelcomeNotice.tsx'
import type { WelcomeNoticeProps } from '../src/client/WelcomeNotice.tsx'
import { decodeWelcomeSection, WelcomeNoticeStore } from '../src/client/welcome-store.ts'
import type { WelcomeSection } from '../src/client/welcome-store.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'

/** Stateless schema service for scope construction in this jsdom fixture. */
const schemaService = new SettingsSchemaService(new Context())

const WELCOME_NOTICE_COPY = {
  en: { title: en.welcomeTitle, body: en.welcomeBody, continueLabel: en.welcomeContinue },
  zh: { title: zh.welcomeTitle, body: zh.welcomeBody, continueLabel: zh.welcomeContinue },
}

let rpc = 0

/** The Remote carrier answers through the rpcId envelope. */
function remoteAnswer<T>(value: T) {
  return { rpcId: `welcome-${rpc++}` as never, result: { ok: true as const, value } }
}

function welcomeView(value: unknown, revision = 0) {
  return {
    ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
    schema: {},
    value,
    applies: 'live' as const,
    secrets: [],
    revision,
  }
}

/** Empty global standard-kit hooks (the step reads none of them). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, observedJobs: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}
function emptyPanelInfo() {
  const store = createSnapshotStore({ activePanelId: null })
  return bindSnapshotSelector(store)
}

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

function mount(
  version?: string,
  mutateImpl: () => Promise<unknown> = () =>
    Promise.resolve(remoteAnswer(welcomeView({ [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION }, 1))),
) {
  const appRoot = document.createElement('div')
  appRoot.id = 'root'
  document.body.append(appRoot)
  const mutate = vi.fn(mutateImpl)
  const api = {
    settings: {
      describe: () => Promise.resolve(remoteAnswer({
        writable: true,
        hasDocument: false,
        namespaces: [welcomeView(version === undefined ? {} : { [WELCOME_NOTICE_ACK_FIELD]: version })],
      })),
      mutate,
    },
  }
  const wire = { settings: api.settings } as never
  const mirror = new SettingsDescribeMirror(wire)
  const scope = new SettingsScopeController<WelcomeSection>(
    wire,
    { namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE, decode: decodeWelcomeSection },
    mirror,
    'host',
    schemaService,
  )
  const controller = new WelcomeNoticeStore(scope)
  void mirror.load()
  const complete = vi.fn()
  const props: WelcomeNoticeProps = {
    stepId: 'welcome-notice',
    complete,
    openSection: vi.fn(),
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    usePanelInfo: emptyPanelInfo(),
    controller,
    useWelcome: bindSnapshotSelector(controller.store),
    t: (key: keyof typeof zh) => zh[key],
  }
  return { ...render(<WelcomeNotice {...props} />), complete, controller, mirror, mutate, appRoot }
}

describe('WelcomeNotice', () => {
  it('uses the exact owner copy in both GUI locales', () => {
    expect(WELCOME_NOTICE_COPY.en).toEqual({
      title: 'Preview Notice',
      body: 'DeepSeek Harness 0.2 is still in preview, and many areas need continued improvement and refinement. We welcome feedback and suggestions from all developers and users. The new desktop app now targets a broad range of users, while developer-related advanced features can be enabled in the settings. DeepSeek Harness’s product features and plugin APIs are expected to continue rapid iteration and evolution, and will gradually stabilize over time.\n\nWe look forward to exploring the limits of intelligence together with users and developers around the world, building on open-source, reusable, and composable infrastructure. We welcome everyone to bring their ideas to life with DeepSeek Harness and participate in the community to enrich the plugin ecosystem.',
      continueLabel: 'Continue',
    })
    expect(en.welcomeBody).toBe(WELCOME_NOTICE_COPY.en.body)
    expect(zh.welcomeBody).toBe(WELCOME_NOTICE_COPY.zh.body)
  })

  it('renders one blocking modal action and focuses the title', async () => {
    const h = mount()
    const dialog = await screen.findByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    for (const paragraph of WELCOME_NOTICE_COPY.zh.body.split('\n\n')) {
      expect(screen.getByText(paragraph, { exact: true })).toBeTruthy()
    }
    expect(dialog.querySelectorAll('p')).toHaveLength(2)
    expect(dialog.querySelectorAll('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: WELCOME_NOTICE_COPY.zh.title }))
    expect(h.appRoot.inert).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('[class*="mask"]')!)
    expect(h.complete).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('requires a fresh acknowledgement after the 0.1 notice', async () => {
    const h = mount('2026-08-13.1')
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }))
    await act(async () => { await Promise.resolve() })
    expect(h.mutate).toHaveBeenCalledOnce()
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('skips itself when this exact version was already acknowledged', async () => {
    const h = mount(WELCOME_NOTICE_VERSION)
    await act(async () => {
      await h.mirror.load()
      await h.controller.load()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('keeps the sole action disabled while saving and reports a refused write', async () => {
    let resolveWrite!: (value: unknown) => void
    const write = new Promise<unknown>((resolve) => { resolveWrite = resolve })
    const h = mount(undefined, () => write)
    await screen.findByRole('dialog')
    const action = screen.getByRole<HTMLButtonElement>('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel })
    fireEvent.click(action)
    expect(action.disabled).toBe(true)
    resolveWrite({
      rpcId: 'welcome-write' as never,
      result: {
        ok: false,
        error: new RemoteError('gateway/internal', 'read only', {}),
      },
    })
    expect((await screen.findByRole('alert')).textContent).toBe(zh.welcomeError)
    expect(h.complete).not.toHaveBeenCalled()
  })
})
