import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/remote'

// The generated remote artifact lives in lib/, which no-build test lanes
// cannot resolve; the client entry only forwards the contribution.
vi.mock('@deepseek-ai/dsh-experimental-agent-team/remote', () => ({ default: { package: '@deepseek-ai/dsh-experimental-agent-team', descriptors: [] } }))
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { TeamAction, type TeamActionInjected } from '../src/client/TeamAction.tsx'
import { inject, mountAgentTeamUi } from '../src/client/mount.ts'
import { apply as clientApply } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const SESSION = 'team-session' as SessionId
const CHILD = 'team-child' as SessionId
const REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-experimental-agent-team',
  descriptors: [],
}

async function bench(options: {
  registrationFailure?: boolean
  setEnabledFailure?: boolean
  refreshGate?: Promise<void>
  clientApply?: (ctx: Context) => Promise<unknown>
} = {}) {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  class RemoteService extends Service {
    readonly disposeMount = vi.fn(() => Promise.resolve())
    readonly mount = vi.fn((_contribution: unknown) => Promise.resolve(this.disposeMount))

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $mount(contribution: unknown): Promise<() => Promise<void>> {
      return this.mount(contribution)
    }
  }
  const remote = new RemoteService(ctx)
  ctx.provide('remote.agentTeams', {
    setEnabled: (sessionId: SessionId, enabled: boolean) => {
      calls.push({ method: 'agentTeams/setEnabled', args: [sessionId, enabled] })
      return Promise.resolve(options.setEnabledFailure === true
        ? { ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }
        : { ok: true as const, value: undefined })
    },
  })
  const navigation: unknown[] = []
  let mainSessionId: SessionId = SESSION
  let pendingNavigation: AbortController | undefined
  ctx.provide('sessions', {
    beginNavigation: () => {
      pendingNavigation?.abort()
      pendingNavigation = new AbortController()
      return pendingNavigation.signal
    },
    finishNavigation: (signal: AbortSignal) => {
      if (pendingNavigation?.signal === signal) pendingNavigation = undefined
    },
    refreshSubagents: (id: SessionId) => {
      navigation.push(['refresh', id])
      return options.refreshGate ?? Promise.resolve()
    },
    list: {
      getSnapshot: () => ({ current: mainSessionId }),
      subscribe: () => () => {},
    },
    openSubagent: (address: unknown) => { navigation.push(['open', address]) },
    open: (id: SessionId) => { navigation.push(['openSession', id]) },
  } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const collapseHeader = ctx.slots.register({
    name: 'root',
    children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  if (options.registrationFailure === true) {
    vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot registration failed') })
  }
  const fiber = options.registrationFailure === true
    ? ctx.plugin({ apply() {} })
    : ctx.plugin({ inject: [...inject], apply: options.clientApply ?? (clientCtx => mountAgentTeamUi(clientCtx, REMOTE)) })
  const activation: Promise<unknown> = options.registrationFailure === true
    ? mountAgentTeamUi(ctx, REMOTE).catch((error: unknown) => error)
    : fiber.await()
  if (options.registrationFailure !== true) {
    await activation
  } else {
    await fiber.await()
  }
  const entry = () => ctx.slots.entries('conversation.session.header.actions')
    .find(candidate => candidate.component === TeamAction)
  return {
    ctx,
    fiber,
    activation,
    calls,
    navigation,
    remote,
    entry,
    collapseHeader,
    select: (sessionId: SessionId) => {
      pendingNavigation?.abort()
      mainSessionId = sessionId
    },
  }
}

describe('ui-team browser plugin', () => {
  it('registers one disposable header action wired to agentTeams/setEnabled', async () => {
    const b = await bench()
    expect(inject).toEqual(['sessions', 'remote', 'slots', 'locale'])
    expect(b.entry()).toMatchObject({
      options: { id: 'agent-team', order: 20 },
      locale: 'agent-team',
    })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.remote.mount).toHaveBeenCalledWith(REMOTE)
    const actions = (b.entry()!.inject as unknown as () => TeamActionInjected)()
    expect(await actions.selectTeamMode(SESSION, true)).toBeNull()
    expect(b.calls).toEqual([{ method: 'agentTeams/setEnabled', args: [SESSION, true] }])
    await actions.openTeammate(SESSION, SESSION)
    expect(b.navigation).toEqual([['openSession', SESSION]])
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.remote.disposeMount).toHaveBeenCalledOnce()
  })

  it('unmounts the Remote contribution when later Client registration fails', async () => {
    const b = await bench({ registrationFailure: true })
    await expect(b.activation).resolves.toMatchObject({ message: 'slot registration failed' })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.remote.disposeMount).toHaveBeenCalledOnce()
  })

  it('returns Remote carrier failures as the mode-selection message', async () => {
    const b = await bench({ setEnabledFailure: true })
    const actions = (b.entry()!.inject as unknown as () => TeamActionInjected)()
    await expect(actions.selectTeamMode(SESSION, false)).resolves.toBe('offline')
  })

  it('refreshes the catalog before opening a continuable teammate address', async () => {
    const b = await bench()
    const actions = (b.entry()!.inject as unknown as () => TeamActionInjected)()
    await actions.openTeammate(SESSION, CHILD)
    expect(b.navigation).toEqual([
      ['refresh', SESSION],
      ['open', {
        parentSessionId: SESSION,
        childSessionId: CHILD,
        mode: 'continuable',
      }],
    ])
  })

  it('does not open a teammate after selection changes during catalog refresh', async () => {
    const refresh = Promise.withResolvers<undefined>()
    const b = await bench({ refreshGate: refresh.promise })
    const actions = (b.entry()!.inject as unknown as () => TeamActionInjected)()
    const opening = actions.openTeammate(SESSION, CHILD)
    expect(b.navigation).toEqual([['refresh', SESSION]])
    b.select('other-session' as SessionId)
    refresh.resolve(undefined)
    await opening
    expect(b.navigation).toEqual([['refresh', SESSION]])
  })
})

describe('client entry', () => {
  it('mounts through the browser apply path', async () => {
    const b = await bench({ clientApply })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.entry()).toBeDefined()
    void nodeApply
  })
})
