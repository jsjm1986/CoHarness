/**
 * Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
 * *references* to secrets — environment-variable names — while providers own
 * the actual values and their storage. Consumers resolve a reference once per
 * operation, so a changed credential reaches the next operation without any
 * plugin restart, and configuration surfaces describe a reference without
 * ever seeing its value.
 * @module @deepseek-ai/dsh-credentials
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialRef } from './types.ts'

export type { CredentialRef } from './types.ts'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
 * @returns the branded reference.
 */
export function credentialRef(value: string): CredentialRef {
  if (!REF_PATTERN.test(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value as CredentialRef
}

/** One resolved credential value and the source layer that supplied it. */
export interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}

/** Source and writability facts for one reference, safe for configuration UIs — never the value. */
export interface CredentialInfo {
  /** Whether {@link CredentialProvider.resolve} would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether {@link CredentialProvider.set} would currently succeed for this reference. */
  writable: boolean
}

/** One externally supplied read-only credential layer with exclusive reference ownership. */
export interface ReadOnlyCredentialLayer {
  /** Stable diagnostic id for registration and write refusals. */
  readonly id: string
  /** Return whether this layer exclusively owns one reference. */
  owns(ref: CredentialRef): boolean
  /** Resolve an owned reference without falling through to the writable Provider source. */
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  /** Describe an owned reference without exposing its value. */
  describe(ref: CredentialRef): Promise<CredentialInfo>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    credentials: CredentialProvider
  }
}

/**
 * Abstract credential service. Providers implement one writable source and
 * may accept disjoint read-only layers. A read-only layer exclusively owns
 * every reference it claims, so resolution never falls through to a personal
 * value and writes reject. An empty stored value is absent everywhere.
 */
export abstract class CredentialProvider extends Service {
  private readonly readOnlyLayers = new Map<string, ReadOnlyCredentialLayer>()

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Register one disjoint read-only source layer.
   * @param layer - source ownership, value resolution, and value-free description.
   * @returns an exact-registration disposer.
   */
  registerReadOnlyLayer(layer: ReadOnlyCredentialLayer): () => void {
    if (layer.id.length === 0 || layer.id.trim() !== layer.id || /\s/.test(layer.id)) {
      throw new Error('credentials: read-only layer id must be non-blank and contain no whitespace')
    }
    if (this.readOnlyLayers.has(layer.id)) {
      throw new Error(`credentials: read-only layer "${layer.id}" is already registered`)
    }
    this.readOnlyLayers.set(layer.id, layer)
    return () => {
      if (this.readOnlyLayers.get(layer.id) === layer) this.readOnlyLayers.delete(layer.id)
    }
  }

  private readOnlyLayer(ref: CredentialRef): ReadOnlyCredentialLayer | undefined {
    const matches = [...this.readOnlyLayers.values()].filter(layer => layer.owns(ref))
    if (matches.length > 1) {
      throw new Error(`credentials: reference "${ref}" is owned by multiple read-only layers: ${matches.map(layer => layer.id).join(', ')}`)
    }
    return matches[0]
  }

  /**
   * Resolve one reference to its current value. Resolution is per call:
   * consumers re-resolve at each operation and must not cache across
   * operations — that per-operation read is what makes a changed credential
   * reach the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.readOnlyLayer(ref)?.resolve(ref) ?? this.resolveOwned(ref)
  }

  /**
   * Describe one reference for configuration surfaces without exposing the
   * value.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return this.readOnlyLayer(ref)?.describe(ref) ?? this.describeOwned(ref)
  }

  /**
   * Durably store one value in the provider-managed writable source. Rejects
   * while a read-only source shadows the reference — the write would appear
   * to succeed while resolution keeps returning the shadowing value — and
   * rejects an empty value (use {@link unset}).
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      return Promise.reject(new Error(`credentials: an empty value cannot be stored for "${ref}"; use unset`))
    }
    const layer = this.readOnlyLayer(ref)
    if (layer !== undefined) {
      return Promise.reject(new Error(`credentials: reference "${ref}" is read-only in layer "${layer.id}"`))
    }
    return this.setOwned(ref, value)
  }

  /**
   * Remove one reference from the provider-managed writable source; removing
   * an absent reference is a no-op. Rejects while a read-only source shadows
   * the reference, like {@link set}.
   * @param ref - the reference to remove.
   */
  unset(ref: CredentialRef): Promise<void> {
    const layer = this.readOnlyLayer(ref)
    if (layer !== undefined) {
      return Promise.reject(new Error(`credentials: reference "${ref}" is read-only in layer "${layer.id}"`))
    }
    return this.unsetOwned(ref)
  }

  /** Resolve one reference from the Provider's writable source layers. */
  protected abstract resolveOwned(ref: CredentialRef): Promise<ResolvedCredential | undefined>

  /** Describe one reference from the Provider's writable source layers. */
  protected abstract describeOwned(ref: CredentialRef): Promise<CredentialInfo>

  /** Store one validated non-empty value in the Provider's writable source. */
  protected abstract setOwned(ref: CredentialRef, value: string): Promise<void>

  /** Remove one reference from the Provider's writable source. */
  protected abstract unsetOwned(ref: CredentialRef): Promise<void>

  /* jscpd:ignore-start -- deliberate symmetry with the settings seam's commit
     fan-out: the contained-dispatch shape is the reviewed listener-lifecycle
     contract, and extracting it would couple the two seams' event semantics. */
  /**
   * Fan `credentials/updated` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the committed operation's outcome — except `INVARIANT`-coded
   * failures, which rethrow after every listener ran (the rethrow reaches the
   * caller only from synchronous listeners, so invariant checks on this event
   * must not be async functions). Providers call this only after the write or
   * reload actually committed, so a broken observer can never make a durable
   * change look failed.
   * @param ref - the reference whose stored value changed.
   */
  protected notifyUpdated(ref: CredentialRef): void {
    let invariantFailure: unknown
    const args = ['credentials/updated', ref]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(ref)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(ref, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(ref, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(ref: CredentialRef, error: unknown): void {
    this.ctx.logger.warn('credentials: a credentials/updated listener for "%s" failed', ref)
    this.ctx.logger.warn(error)
  }
}

export default CredentialProvider
