/** Test double for the client settings-scope seam. */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** Handle over one stubbed scope: the scope, its write spy, and publication controls. */
export interface StubSettingsScope<T> {
  /** The scope face handed to the service under test. */
  scope: SettingsScope<T>
  /** Spy behind `scope.set`; resolves immediately. */
  set: ReturnType<typeof vi.fn>
  /** Spy behind `scope.unset`; resolves immediately. */
  unset: ReturnType<typeof vi.fn>
  /** @returns how many listeners are currently subscribed (disposal assertions). */
  listenerCount(): number
  /**
   * Replace part of the snapshot and notify subscribers, as a Host
   * acceptance would.
   * @param next - snapshot fields to replace.
   */
  publish(next: Partial<SettingsScopeSnapshot<T>>): void
}

/**
 * Build an in-memory settings scope for service specs: starts in the host
 * loading state, records writes, and lets the test publish Host acceptances.
 * @returns the stub handle.
 */
export function stubSettingsScope<T>(): StubSettingsScope<T> {
  let snapshot: SettingsScopeSnapshot<T> = {
    status: 'loading', value: undefined, base: undefined, user: undefined,
    revision: undefined, writable: false, writableReason: undefined,
    write: { status: 'idle' }, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(() => Promise.resolve())
  const unset = vi.fn(() => Promise.resolve())
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set,
      unset,
    },
    set,
    unset,
    listenerCount: () => listeners.size,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * The mutation face a Host-backed scope adds over {@link SettingsScope}, as
 * `dsh-client-ui-settings` declares it; typed here structurally so this
 * package keeps no dependency on the surface that implements it.
 */
export interface SettingsMutationScopeStub<T> extends SettingsScope<T> {
  /**
   * Queue one atomic namespace mutation.
   * @param ops - changes applied together by the Host.
   * @param expectedRevision - fixed draft revision, or the latest queued revision when omitted.
   * @returns settlement after the mutation and any recovery read.
   */
  mutate(ops: SettingsPathOpView[], expectedRevision?: number): Promise<void>
}

/** Handle over one stubbed mutation scope: the scope, its write spies, and publication controls. */
export interface StubMutationScope<T> extends Omit<StubSettingsScope<T>, 'scope'> {
  /** The scope face handed to the service under test. */
  scope: SettingsMutationScopeStub<T>
  /** Spy behind `scope.mutate`; resolves immediately. */
  mutate: Mock<(ops: SettingsPathOpView[], expectedRevision?: number) => Promise<void>>
}

/**
 * Build an in-memory mutation scope for service specs: starts in the host
 * loading state, records writes, and lets the test publish Host acceptances.
 * @returns the stub handle.
 */
export function stubMutationScope<T>(): StubMutationScope<T> {
  const base = stubSettingsScope<T>()
  const mutate = vi.fn<(ops: SettingsPathOpView[], expectedRevision?: number) => Promise<void>>(() => Promise.resolve())
  const scope: SettingsMutationScopeStub<T> = { ...base.scope, mutate }
  return { ...base, scope, mutate }
}

/** Handle over the binder's shared developer-tools preference stub. */
export interface StubDeveloperTools {
  /** The `developerTools` member face a `settingsScope` service stub provides. */
  readonly preference: {
    readonly enabled: { getSnapshot(): boolean; subscribe(listener: () => void): () => void }
    setEnabled(enabled: boolean): Promise<void>
  }
  /** Spy behind `preference.setEnabled`; resolves immediately. */
  setEnabled: ReturnType<typeof vi.fn>
  /** Flip the accepted value and notify subscribers.
   * @param enabled - the preference state to publish.
   */
  publish(enabled: boolean): void
}

/**
 * Build the binder's shared developer-tools preference for service stubs:
 * starts enabled, records writes, and lets the test publish flips.
 * @param initial - starting enablement; the shipped default is on.
 * @returns the stub handle.
 */
export function stubDeveloperTools(initial = true): StubDeveloperTools {
  let enabled = initial
  const listeners = new Set<() => void>()
  const setEnabled = vi.fn((next: boolean) => { stub.publish(next); return Promise.resolve() })
  const stub: StubDeveloperTools = {
    preference: {
      enabled: {
        getSnapshot: () => enabled,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      setEnabled: (next: boolean) => setEnabled(next),
    },
    setEnabled,
    publish(next) {
      if (enabled === next) return
      enabled = next
      for (const listener of [...listeners]) listener()
    },
  }
  return stub
}
