/**
 * Real-`Models.login` cancellation lifecycle: the authorization seam's
 * session commit is the login's only write path, so a withdrawn attempt
 * never publishes its credential while an admitted write completes as
 * `authorized` — against a real Loader composition over credentials-local,
 * authorization, and a controlled OAuth provider.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { OAuthCredential, Provider, ProviderAuthInteraction } from '@earendil-works/pi-ai'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { recordKeyFor } from '../src/auth.ts'
import { loadLoginComposition } from './fixtures/login-lifecycle.fixture.ts'

const KEY = recordKeyFor('openai-codex')
const GRANTED: OAuthCredential = { type: 'oauth', access: 'probe-access', refresh: 'probe-refresh', expires: 1 }

/** Deferred promise with its resolver. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve: (value: T) => { resolve(value) } }
}

/**
 * A controlled OAuth provider: `login` resolves the supplied credential once
 * the optional gate lets it through; every other member fails the test if
 * pi-ai reaches it.
 */
function controlledProvider(gate?: Promise<void>, onEnter?: () => void): Provider {
  return {
    id: 'openai-codex',
    name: 'probe',
    auth: {
      oauth: {
        name: 'probe oauth',
        async login(_interaction: ProviderAuthInteraction) {
          onEnter?.()
          await gate
          return GRANTED
        },
        refresh: () => { throw new Error('unused') },
        toAuth: () => { throw new Error('unused') },
      },
    },
    getModels: () => [],
    stream: () => { throw new Error('unused') },
    streamSimple: () => { throw new Error('unused') },
  }
}

const interaction = {
  notify: () => {},
  prompt: () => Promise.reject(new AuthorizationDeclinedError()),
}

async function record(ctx: { credentials: { readRecord(k: CredentialKey): Promise<CredentialRecord | undefined> } }) {
  return ctx.credentials.readRecord(KEY)
}

describe('login cancellation against the real Models.login', () => {
  it('publishes nothing when the caller cancels while the provider awaits OAuth', async () => {
    const loginGate = deferred()
    const entered = deferred()
    const composition = await loadLoginComposition(
      controlledProvider(loginGate.promise, () => { entered.resolve() }), 'openai-codex')
    try {
      const controller = new AbortController()
      const settled = vi.fn()
      composition.ctx.on('authorization/settled', settled)

      const attempt = composition.ctx.authorization.begin({
        key: KEY, interaction, signal: controller.signal,
      })
      await entered.promise
      controller.abort()
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })

      // The orphaned provider login still resolves its gate; pi-ai already
      // raced it out, so the credential never reaches the store.
      loginGate.resolve()
      await vi.waitFor(() => {
        expect(composition.ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
      expect(settled).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
      expect(await record(composition.ctx)).toBeUndefined()
      await expect(readFile(composition.credentialsFile, 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      loginGate.resolve()
      await composition.dispose()
    }
  })

  it('rejects a write that was still queued behind another credential operation', async () => {
    // The OAuth exchange is held open until the write barrier is in place, so
    // the login's `store.modify` provably enrolls behind a held provider op
    // before cancellation lands.
    const loginGate = deferred()
    const loginEntered = deferred()
    const composition = await loadLoginComposition(
      controlledProvider(loginGate.promise, () => { loginEntered.resolve() }), 'openai-codex')
    const heldRelease = deferred()
    let held: Promise<CredentialRecord | undefined> | undefined
    try {
      const heldMutating = deferred()
      const writeEnqueued = deferred()
      let heldRunning = false
      const settled = vi.fn()
      composition.ctx.on('authorization/settled', settled)
      // Occupy the provider's serialized operation chain before the login's
      // write is allowed to arrive; its enrollment is observed at modifyRecord.
      composition.credentials.onEnqueued = (key) => {
        if (key === KEY && heldRunning) writeEnqueued.resolve()
      }
      const controller = new AbortController()
      const attempt = composition.ctx.authorization.begin({
        key: KEY, interaction, signal: controller.signal,
      })
      await loginEntered.promise
      held = composition.ctx.credentials.modifyRecord(KEY, async () => {
        heldRunning = true
        heldMutating.resolve()
        await heldRelease.promise
        return undefined
      })
      void held.catch(() => undefined)
      await heldMutating.promise
      loginGate.resolve()
      await writeEnqueued.promise

      controller.abort()
      await expect(attempt).resolves.toEqual({ status: 'cancelled' })
      expect(composition.ctx.authorization.describe(KEY)?.inFlight).toBe(true)
      expect(settled).not.toHaveBeenCalled()
      await expect(composition.ctx.authorization.begin({ key: KEY, interaction }))
        .rejects.toThrow(/already running/)

      heldRelease.resolve()
      await held
      await vi.waitFor(() => {
        expect(composition.ctx.authorization.describe(KEY)?.inFlight).toBe(false)
      })
      expect(settled).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
      expect(await record(composition.ctx)).toBeUndefined()
    } finally {
      heldRelease.resolve()
      if (held !== undefined) await held.catch(() => undefined)
      loginGate.resolve()
      await composition.dispose()
    }
  })

  it('settles authorized when cancellation lands after the write was admitted', async () => {
    const composition = await loadLoginComposition(controlledProvider(), 'openai-codex')
    const storage = deferred()
    try {
      const admitted = deferred()
      const settled = vi.fn()
      composition.ctx.on('authorization/settled', settled)
      composition.credentials.afterAdmission = async () => {
        admitted.resolve()
        await storage.promise
      }

      const controller = new AbortController()
      const attempt = composition.ctx.authorization.begin({
        key: KEY, interaction, signal: controller.signal,
      })
      await admitted.promise
      controller.abort()
      // The caller stays pending on the admitted write and the key stays held.
      let answered = false
      void attempt.then(() => { answered = true }, () => { answered = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(answered).toBe(false)
      await expect(composition.ctx.authorization.begin({ key: KEY, interaction }))
        .rejects.toThrow(/already running/)

      storage.resolve()
      await expect(attempt).resolves.toEqual({ status: 'authorized' })
      expect(settled).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith(KEY, 'authorized')
      expect(await record(composition.ctx)).toEqual({
        kind: 'grant',
        payload: { type: 'oauth', access: 'probe-access', refresh: 'probe-refresh', expires: 1 },
      })
      expect(await readFile(composition.credentialsFile, 'utf8')).toContain('probe-access')
    } finally {
      storage.resolve()
      await composition.dispose()
    }
  })

  it('reports the storage failure, not cancelled, when an admitted write fails', async () => {
    const composition = await loadLoginComposition(controlledProvider(), 'openai-codex')
    const storage = deferred()
    const sentinel = new Error('storage exploded')
    try {
      const admitted = deferred()
      const settled = vi.fn()
      composition.ctx.on('authorization/settled', settled)
      composition.credentials.afterAdmission = async () => {
        admitted.resolve()
        await storage.promise
        throw sentinel
      }

      const controller = new AbortController()
      const attempt = composition.ctx.authorization.begin({
        key: KEY, interaction, signal: controller.signal,
      })
      await admitted.promise
      controller.abort()
      let answered = false
      void attempt.then(() => { answered = true }, () => { answered = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(answered).toBe(false)

      storage.resolve()
      // pi-ai wraps the store rejection in a ModelsError; the storage failure
      // itself is preserved as the cause, not reported as a cancellation.
      const failure: unknown = await attempt.then(() => undefined, (error: unknown): unknown => error)
      expect((failure as { cause?: unknown }).cause).toBe(sentinel)
      expect(settled).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith(KEY, 'failed')
      expect(await record(composition.ctx)).toBeUndefined()
      await expect(readFile(composition.credentialsFile, 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      storage.resolve()
      await composition.dispose()
    }
  })
})
