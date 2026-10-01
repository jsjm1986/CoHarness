import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, {
  AuthorizationDeclinedError,
  type AuthorizationFlow,
  type AuthorizationInteraction,
  type AuthorizationSession,
} from '@deepseek-ai/dsh-authorization'
import { MemoryCredentials } from './memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const OTHER = credentialKey('llm-pi-ai', 'anthropic')

/** A context with the record store the seam confirms commits against. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  return ctx
}

/** An interaction that answers every prompt with the same string. */
function surface(answer = 'typed'): AuthorizationInteraction & {
  notices: unknown[]
  prompts: unknown[]
} {
  const notices: unknown[] = []
  const prompts: unknown[] = []
  return {
    notices,
    prompts,
    notify: (notice) => { notices.push(notice) },
    prompt: (prompt) => {
      prompts.push(prompt)
      return Promise.resolve(answer)
    },
  }
}

/** A flow that commits `key` through its session and then resolves. */
function committingFlow(
  _ctx: Context,
  key = KEY,
  run?: (session: AuthorizationSession) => Promise<void>,
): AuthorizationFlow {
  return {
    key,
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
    async run(session) {
      await run?.(session)
      await session.commit(() =>
        Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
    },
  }
}

describe('AuthorizationService registry', () => {
  it('lists a registered flow and drops it when the registration is disposed', async () => {
    const ctx = await harness()

    const dispose = ctx.authorization.registerFlow(committingFlow(ctx))

    expect(ctx.authorization.list()).toEqual([{
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
      inFlight: false,
    }])
    expect(ctx.authorization.describe(KEY)?.label).toBe('ChatGPT (Codex)')
    expect(ctx.authorization.describe(OTHER)).toBeUndefined()

    dispose()

    expect(ctx.authorization.list()).toEqual([])
    expect(ctx.authorization.describe(KEY)).toBeUndefined()
  })

  it('refuses a second flow for the same key', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    expect(() => ctx.authorization.registerFlow(committingFlow(ctx)))
      .toThrow(/already registered/)
  })

  it('withdraws an attempt still running when its flow leaves', async () => {
    const ctx = await harness()
    let started: (() => void) | undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const dispose = ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        started?.()
        session.signal.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
      })))

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await running
    dispose()

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
  })
})

describe('AuthorizationService.begin', () => {
  it('runs the flow, confirms the committed record, and reports the settlement', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })

    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: 'granted' } })
    expect(settled).toHaveBeenCalledWith(KEY, 'authorized')
  })

  it('runs the flow first method when the caller names none, and the named one when it does', async () => {
    const ctx = await harness()
    const seen: string[] = []
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, (session) => {
      seen.push(session.method)
      return Promise.resolve()
    }))

    await ctx.authorization.begin({ key: KEY, interaction: surface() })
    await ctx.authorization.begin({ key: KEY, method: 'api-key', interaction: surface() })

    expect(seen).toEqual(['oauth', 'api-key'])
  })

  it('carries notices and prompts between the flow and the calling surface', async () => {
    const ctx = await harness()
    const answers: string[] = []
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
      answers.push(await session.prompt({ kind: 'text', message: 'Paste the code' }))
    }))
    const ui = surface('code-123')

    await ctx.authorization.begin({ key: KEY, interaction: ui })

    expect(ui.notices).toEqual([{ message: 'Continue in your browser', url: 'https://auth.example/start' }])
    expect(ui.prompts).toEqual([{ kind: 'text', message: 'Paste the code' }])
    expect(answers).toEqual(['code-123'])
  })

  it('refuses a key no flow claims', async () => {
    const ctx = await harness()

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/no authorization flow is registered/)
  })

  it('refuses a method the flow does not offer', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    await expect(ctx.authorization.begin({ key: KEY, method: 'device', interaction: surface() }))
      .rejects.toThrow(/offers no method "device"/)
  })

  it('refuses a second attempt while one is running, and admits one after it settles', async () => {
    const ctx = await harness()
    // Only the first attempt blocks; the later ones must be free to complete,
    // which is what shows the key was released rather than merely idle-looking.
    const held = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    let first = true
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => {
      if (!first) return Promise.resolve()
      first = false
      started.resolve(undefined)
      return held.promise
    }))

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await started.promise
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)
    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/already running/)

    held.resolve(undefined)
    await expect(attempt).resolves.toEqual({ status: 'authorized' })
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })
  })

  it('never starts a flow whose caller withdrew before begin', async () => {
    const ctx = await harness()
    const ran = vi.fn()
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => {
      ran()
      return new Promise(() => {})
    }))

    await expect(ctx.authorization.begin({
      key: KEY,
      interaction: surface(),
      signal: AbortSignal.abort(),
    })).resolves.toEqual({ status: 'cancelled' })

    expect(ran).not.toHaveBeenCalled()
    // Nothing occupied the key, so nothing settled on it either.
    expect(settled).not.toHaveBeenCalled()
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('still reports an unknown method to a caller that already withdrew', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    await expect(ctx.authorization.begin({
      key: KEY,
      method: 'device',
      interaction: surface(),
      signal: AbortSignal.abort(),
    })).rejects.toThrow(/offers no method "device"/)
  })

  it('reports a caller that withdraws mid-flight as cancelled', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        controller.abort()
      })))

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal }))
      .resolves.toEqual({ status: 'cancelled' })
  })

  it('withdraws a running attempt through cancel(), and ignores cancel() for an idle key', async () => {
    const ctx = await harness()
    const started = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
        started.resolve(undefined)
      })))
    ctx.authorization.cancel(OTHER)

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await started.promise
    ctx.authorization.cancel(KEY)

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
  })

  it('holds the key until a withdrawn flow that ignores its signal settles', async () => {
    const ctx = await harness()
    const orphan = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    let captured: AuthorizationSession | undefined
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, (session) => {
      captured = session
      started.resolve(undefined)
      return orphan.promise
    }))

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    try {
      await started.promise
      ctx.authorization.cancel(KEY)

      // The caller hears promptly; the reservation stays until the uncooperative
      // flow quiesces, and the settlement event fires only after release.
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })
      expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)
      await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
        .rejects.toThrow(/already running/)
      await expect(captured!.commit(() =>
        Promise.resolve({ kind: 'grant', payload: { token: 'late' } })))
        .rejects.toThrow(/WITHDRAWN|withdrawn|no longer holds/)
      expect(settled).not.toHaveBeenCalled()

      orphan.reject(new Error('gave up long after the human left'))
      await expect(orphan.promise).rejects.toThrow('gave up long after the human left')
      // Release follows the orphan's actual settlement, not the caller's answer.
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
      expect(settled).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
    } finally {
      orphan.reject(new Error('cleanup: orphan still held'))
      await orphan.promise.catch(() => undefined)
      await attempt.catch(() => undefined)
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
    }
  })

  it('propagates a flow failure to its caller and settles the key as failed', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () =>
      Promise.reject(new Error('the token endpoint said no'))))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow('the token endpoint said no')

    expect(settled).toHaveBeenCalledWith(KEY, 'failed')
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('refuses a flow that resolves without committing its record', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Forgetful',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => Promise.resolve(),
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/resolved without committing a credential record/)
  })
})

describe('commit confirmation', () => {
  it('refuses a re-auth that left only the record of an earlier attempt', async () => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(KEY, () =>
      Promise.resolve({ kind: 'grant', payload: { token: 'stale' } }))
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Forgetful',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      // A commit for another key is not this flow's commit either.
      async run() {
        await ctx.credentials.modifyRecord(OTHER, () =>
          Promise.resolve({ kind: 'grant', payload: { token: 'other' } }))
      },
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/without committing a credential record in this attempt/)
    // Refused, not cleaned up: the stale record still belongs to its owner.
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: 'stale' } })
  })

  it('refuses a flow that committed and then deleted its record', async () => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(KEY, () =>
      Promise.resolve({ kind: 'grant', payload: { token: 'stale' } }))
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Destructive',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.commit(() => Promise.resolve({ kind: 'grant', payload: { token: 'fresh' } }))
        await ctx.credentials.deleteRecord(KEY)
      },
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/deleted its credential record/)
  })
})

describe('declined prompts', () => {
  it('reports an attempt whose prompt the human declined as cancelled, not failed', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Paste the code' })
    }))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    const declining: AuthorizationInteraction = {
      notify: () => undefined,
      prompt: () => Promise.reject(new AuthorizationDeclinedError()),
    }

    await expect(ctx.authorization.begin({ key: KEY, interaction: declining }))
      .resolves.toEqual({ status: 'cancelled' })

    expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
  })

  it('reads a decline through a flow that rewraps the rejection on its way out', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      session.prompt({ kind: 'text', message: 'Paste the code' }).then(
        () => undefined,
        () => {
          throw new Error('sign-in aborted')
        })))
    const declining: AuthorizationInteraction = {
      notify: () => undefined,
      prompt: () => Promise.reject(new AuthorizationDeclinedError()),
    }

    await expect(ctx.authorization.begin({ key: KEY, interaction: declining }))
      .resolves.toEqual({ status: 'cancelled' })
  })

  it('keeps a prompt failure that is not a decline a flow failure', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Paste the code' })
    }))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    const broken: AuthorizationInteraction = {
      notify: () => undefined,
      prompt: () => Promise.reject(new Error('the transport dropped')),
    }

    await expect(ctx.authorization.begin({ key: KEY, interaction: broken }))
      .rejects.toThrow('the transport dropped')

    expect(settled).toHaveBeenCalledWith(KEY, 'failed')
  })
})

describe('notice containment', () => {
  it('loses the notice, never the attempt, when the surface cannot render it', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, (session) => {
      session.notify({ message: 'Continue in your browser' })
      return Promise.resolve()
    }))
    const broken: AuthorizationInteraction = {
      notify: () => {
        throw new Error('page connection closed')
      },
      prompt: () => Promise.resolve('unused'),
    }

    await expect(ctx.authorization.begin({ key: KEY, interaction: broken }))
      .resolves.toEqual({ status: 'authorized' })
  })
})

describe('session.commit and cancellation', () => {
  const grant = (token: string) => ({ kind: 'grant' as const, payload: { token } })
  const store = (ctx: Context): MemoryCredentials => ctx.credentials as MemoryCredentials

  it('rejects a commit called on a captured session after withdrawal', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    let captured: AuthorizationSession | undefined
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, (session) => {
      captured = session
      started.resolve(undefined)
      return gate.promise
    }))
    const controller = new AbortController()
    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal })

    try {
      await started.promise
      controller.abort()
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })

      gate.resolve(undefined)
      await expect(captured!.commit(() => Promise.resolve(grant('late')))).rejects.toThrow(/no longer holds/)
      expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
      expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
    } finally {
      gate.resolve(undefined)
      controller.abort()
      await attempt.catch(() => undefined)
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
    }
  })

  it('never publishes a commit that was queued behind another write when cancelled', async () => {
    const ctx = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flowDone = Promise.withResolvers<undefined>()
    const writeCount = vi.fn()
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Queued',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        const first = session.commit(async () => {
          entered.resolve(undefined)
          await release.promise
          return grant('first')
        })
        // The second commit queues behind the first on the same attempt.
        const second = session.commit(async () => {
          writeCount()
          return grant('second')
        }).then(record => record, () => undefined)
        void first.catch(() => undefined)
        await second
        await flowDone.promise
      },
    })
    const controller = new AbortController()
    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal })

    try {
      await entered.promise
      controller.abort()
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })
      expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)

      release.resolve(undefined)
      // Neither commit publishes: the first is refused after its mutation, the
      // second at the entry checkpoint. The reservation ends only once the
      // queued work and the flow quiesce.
      flowDone.resolve(undefined)
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
      expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
      expect(writeCount).not.toHaveBeenCalled()
      expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    } finally {
      release.resolve(undefined)
      flowDone.resolve(undefined)
      controller.abort()
      await attempt.catch(() => undefined)
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
    }
  })

  it('rejects a replacement when cancellation lands mid-mutation', async () => {
    const ctx = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const finished = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Gated',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        try {
          await session.commit(async () => {
            entered.resolve(undefined)
            await release.promise
            return grant('mid-flight')
          })
        } finally {
          finished.resolve(undefined)
        }
      },
    })
    const controller = new AbortController()
    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal })

    try {
      await entered.promise
      controller.abort()
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })

      release.resolve(undefined)
      await finished.promise
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
      expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    } finally {
      release.resolve(undefined)
      controller.abort()
      await attempt.catch(() => undefined)
      await finished.promise.catch(() => undefined)
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
    }
  })

  it('reports authorized when cancellation lands after the write was admitted', async () => {
    const ctx = await harness()
    const credentials = store(ctx)
    const admitted = Promise.withResolvers<undefined>()
    const storage = Promise.withResolvers<undefined>()
    let writes = 0
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Admitted',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.commit(async () => grant('admitted'))
      },
    })
    // Storage stalls after the mutation was admitted — the committed mark is
    // already set — until the test lets it through.
    credentials.gateWrite = async () => {
      admitted.resolve(undefined)
      await storage.promise
      writes += 1
    }
    const controller = new AbortController()

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal })
    try {
      await admitted.promise
      controller.abort()
      // The caller stays pending on the admitted write, and the key stays held.
      let answered = false
      void attempt.then(() => { answered = true }, () => { answered = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(answered).toBe(false)
      await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
        .rejects.toThrow(/already running/)

      storage.resolve(undefined)
      await expect(attempt).resolves.toEqual({ status: 'authorized' })
      expect(writes).toBe(1)
      expect(await ctx.credentials.readRecord(KEY)).toEqual(grant('admitted'))
    } finally {
      storage.resolve(undefined)
      await attempt.catch(() => undefined)
    }
  })

  it('holds the key while a queued commit survives a settled withdrawn flow', async () => {
    const ctx = await harness()
    const credentials = store(ctx)
    const queued = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    // The provider op is held before the mutation runs, so the commit stays
    // queued — never admitted — for as long as the gate is closed.
    credentials.gateModify = async () => {
      queued.resolve(undefined)
      await release.promise
    }
    let write: Promise<unknown> | undefined
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Queues then leaves',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        write = session.commit(async () => grant('queued'))
        void write.catch(() => undefined)
        // The flow settles promptly on its signal while the write is queued.
        await new Promise<never>((_resolve, reject) => {
          session.signal.addEventListener('abort', () => {
            const reason: unknown = session.signal.reason
            reject(reason instanceof Error ? reason : new Error('withdrawn'))
          }, { once: true })
        })
      },
    })
    const controller = new AbortController()

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal })
    try {
      await queued.promise
      controller.abort()
      // Flow settled, write still queued: the caller hears cancelled, but the
      // reservation and its settlement wait for the queued work.
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })
      expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)
      await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
        .rejects.toThrow(/already running/)
      expect(settled).not.toHaveBeenCalled()

      release.resolve(undefined)
      await expect(write!).rejects.toThrow(/WITHDRAWN|withdrawn|admitted/)
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
      expect(settled).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
      expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    } finally {
      release.resolve(undefined)
      controller.abort()
      if (write !== undefined) await write.catch(() => undefined)
      await attempt.catch(() => undefined)
    }
  })

  it.each(['signal', 'cancel', 'disposal'] as const)(
    'fails a cancelled attempt whose admitted write fails in storage via %s', async (via) => {
      const ctx = await harness()
      const credentials = store(ctx)
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(grant('old')))
      const admitted = Promise.withResolvers<undefined>()
      const storage = Promise.withResolvers<undefined>()
      const sentinel = new Error('storage exploded')
      const settled = vi.fn()
      ctx.on('authorization/settled', settled)
      const dispose = ctx.authorization.registerFlow({
        key: KEY,
        label: 'Fails after admission',
        methods: [{ id: 'oauth', label: 'Sign in' }],
        async run(session) {
          await session.commit(async () => grant('new'))
        },
      })
      credentials.gateWrite = async () => {
        admitted.resolve(undefined)
        await storage.promise
        throw sentinel
      }
      const controller = new AbortController()

      const attempt = ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal })
      try {
        await admitted.promise
        if (via === 'signal') controller.abort()
        else if (via === 'cancel') ctx.authorization.cancel(KEY)
        else dispose()
        // Past admission the withdrawal is ignored: the caller waits for the
        // write and hears its own failure, not a revoked grant.
        let answered = false
        void attempt.then(() => { answered = true }, () => { answered = true })
        await Promise.resolve()
        await Promise.resolve()
        expect(answered).toBe(false)

        storage.resolve(undefined)
        await expect(attempt).rejects.toBe(sentinel)
        expect(settled).toHaveBeenCalledTimes(1)
        expect(settled).toHaveBeenCalledWith(KEY, 'failed')
        expect(await ctx.credentials.readRecord(KEY)).toEqual(grant('old'))
      } finally {
        storage.resolve(undefined)
        await attempt.catch(() => undefined)
      }
    })

  it('does not write or notify for a declined no-op mutation', async () => {
    const ctx = await harness()
    const credentials = store(ctx)
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(grant('stale')))
    const updated = vi.fn()
    ctx.on('credentials/record-updated', updated)
    let writes = 0
    credentials.gateWrite = () => { writes += 1; return Promise.resolve() }
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Noop',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        const declined = await session.commit(() => Promise.resolve(undefined))
        expect(declined).toEqual(grant('stale'))
      },
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/without committing a credential record/)
    expect(writes).toBe(0)
    expect(updated).not.toHaveBeenCalled()
    expect(await ctx.credentials.readRecord(KEY)).toEqual(grant('stale'))
  })

  it('does not publish a cancelled no-op commit', async () => {
    const ctx = await harness()
    const credentials = store(ctx)
    const updated = vi.fn()
    ctx.on('credentials/record-updated', updated)
    let writes = 0
    credentials.gateWrite = () => { writes += 1; return Promise.resolve() }
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Noop gated',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.commit(async () => {
          entered.resolve(undefined)
          await release.promise
          return undefined
        }).then(() => undefined, () => undefined)
      },
    })
    const controller = new AbortController()
    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal })

    try {
      await entered.promise
      controller.abort()
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })
      release.resolve(undefined)
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
      expect(writes).toBe(0)
      expect(updated).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      controller.abort()
      await attempt.catch(() => undefined)
      await vi.waitFor(() => {
        expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
    }
  })

  it('does not count a direct same-key write as the flow commit', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Sideways',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run() {
        // A record write outside the session is never this attempt's commit.
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(grant('sideways')))
      },
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/without committing a credential record/)
    expect(await ctx.credentials.readRecord(KEY)).toEqual(grant('sideways'))
  })

  it('fails a no-op mutation and a commit that leaves the record deleted', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Noop',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.commit(() => Promise.resolve(undefined))
      },
    })
    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/without committing a credential record/)
  })

  it('withdraws a queued or active write when the flow registration is disposed', async () => {
    const ctx = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const finished = Promise.withResolvers<undefined>()
    const dispose = ctx.authorization.registerFlow({
      key: KEY,
      label: 'Disposed',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        try {
          await session.commit(async () => {
            entered.resolve(undefined)
            await release.promise
            return grant('disposed')
          })
        } finally {
          finished.resolve(undefined)
        }
      },
    })

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    try {
      await entered.promise
      dispose()
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })
      release.resolve(undefined)
      await finished.promise
      // The disposed registration is gone entirely; the orphaned write never published.
      expect(ctx.authorization.describe(KEY)).toBeUndefined()
      expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    } finally {
      release.resolve(undefined)
      await attempt.catch(() => undefined)
    }
  })

  it('completes an admitted write even when the flow registration is disposed', async () => {
    const ctx = await harness()
    const credentials = store(ctx)
    const admitted = Promise.withResolvers<undefined>()
    const storage = Promise.withResolvers<undefined>()
    const dispose = ctx.authorization.registerFlow({
      key: KEY,
      label: 'Disposed after admission',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.commit(async () => grant('admitted'))
      },
    })
    credentials.gateWrite = async () => {
      admitted.resolve(undefined)
      await storage.promise
    }

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    try {
      await admitted.promise
      // The write is past its admission checkpoint: disposal withdraws the
      // attempt's remaining life, not the write already handed to storage.
      dispose()
      storage.resolve(undefined)
      await expect(attempt).resolves.toEqual({ status: 'authorized' })
      expect(await ctx.credentials.readRecord(KEY)).toEqual(grant('admitted'))
    } finally {
      storage.resolve(undefined)
      await attempt.catch(() => undefined)
    }
  })

  it('surfaces the storage failure of an admitted commit the flow never awaited', async () => {
    const ctx = await harness()
    const credentials = store(ctx)
    await ctx.credentials.modifyRecord(KEY, async () => grant('old'))
    const admitted = Promise.withResolvers<undefined>()
    const storage = Promise.withResolvers<undefined>()
    const sentinel = new Error('storage exploded')
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Fire and forget',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        void session.commit(async () => grant('new')).catch(() => undefined)
        await admitted.promise
      },
    })
    credentials.gateWrite = async () => {
      admitted.resolve(undefined)
      await storage.promise
      throw sentinel
    }
    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    try {
      await admitted.promise
      storage.resolve(undefined)
      // The write was admitted before run() returned, but never awaited: its
      // storage failure reaches the caller as itself, not as NOT_COMMITTED.
      await expect(attempt).rejects.toBe(sentinel)
      expect(settled).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith(KEY, 'failed')
      expect(await ctx.credentials.readRecord(KEY)).toEqual(grant('old'))
    } finally {
      storage.resolve(undefined)
      await attempt.catch(() => undefined)
    }
  })

  it('drains a failed flow\'s still-running admitted commit before propagating its error', async () => {
    const ctx = await harness()
    const credentials = store(ctx)
    const admitted = Promise.withResolvers<undefined>()
    const storage = Promise.withResolvers<undefined>()
    const flow = Promise.withResolvers<never>()
    const sentinel = new Error('flow exploded')
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Fails mid-write',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run(session) {
        void session.commit(async () => grant('late')).catch(() => undefined)
        return flow.promise
      },
    })
    credentials.gateWrite = async () => {
      admitted.resolve(undefined)
      await storage.promise
    }
    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    try {
      await admitted.promise
      flow.reject(sentinel)
      await expect(flow.promise).rejects.toBe(sentinel)
      // The flow already failed; its owned write still holds storage, so the
      // caller has not heard, the key is reserved, and no settlement fired.
      // The propagation flush keeps the assertion meaningful: without the
      // owned-queue drain, the caller would already have settled here.
      let answered = false
      void attempt.then(() => { answered = true }, () => { answered = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(answered).toBe(false)
      expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)
      await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
        .rejects.toThrow(/already running/)
      expect(settled).not.toHaveBeenCalled()

      storage.resolve(undefined)
      await expect(attempt).rejects.toBe(sentinel)
      expect(settled).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith(KEY, 'failed')
      expect(await ctx.credentials.readRecord(KEY)).toEqual(grant('late'))
    } finally {
      // Repeating a settled resolver is a no-op; on early cleanup it releases
      // the owned flow instead of leaving it unsettled.
      flow.reject(sentinel)
      storage.resolve(undefined)
      await attempt.catch(() => undefined)
    }
  })
})

describe('the settled fan-out', () => {
  it('keeps a throwing listener from changing a finished attempt, and later listeners still run', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    ctx.on('authorization/settled', () => {
      throw new Error('watcher boom')
    })
    const second = vi.fn()
    ctx.on('authorization/settled', second)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })

    expect(second).toHaveBeenCalledWith(KEY, 'authorized')
  })

  it('contains an async listener rejection', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    // An unknown-returning function keeps the typed surface legal while the
    // runtime value is still the rejected promise the containment must handle.
    const boom = (): unknown => Promise.reject(new Error('async watcher boom'))
    ctx.on('authorization/settled', boom)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('rethrows an invariant-coded listener failure after the remaining listeners', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    ctx.on('authorization/settled', () => {
      throw Object.assign(new Error('forged relation'), { code: 'INVARIANT' })
    })
    const second = vi.fn()
    ctx.on('authorization/settled', second)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/forged relation/)
    // Harness-fatal by design — but the record itself committed first.
    expect(second).toHaveBeenCalledWith(KEY, 'authorized')
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: 'granted' } })
  })
})
