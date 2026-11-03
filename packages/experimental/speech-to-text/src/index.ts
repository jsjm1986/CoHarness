/** Named transcription providers with disposable registration and explicit routing. */
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the `settings` service whose `speech-to-text` scope persists `configure()`, and the Loader's
// `loader/volatile-update` merges.
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SpeechPreparationOptions, SpeechProvider, SpeechProviderId, SpeechProviderInfo, SpeechSnapshot, SpeechSelectionPatch, SpeechRequest, SpeechSpec, Transcript } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental speech recognition provider registry. */
    speechToText: SpeechToText
  }
}

/** User-layer selection fields persisted under the `speech-to-text` settings namespace. */
interface SpeechSelectionSection {
  defaultProvider: string
  language: string
}

/** Live selection read before a transcription starts; `configure()` writes it through the Settings service. */
export interface Config {
  /** Registered provider selected when the caller omits an id. */
  defaultProvider: Volatile<string>
  /** Provider language hint selected when the caller omits one. */
  language: Volatile<string>
}

interface Registration {
  readonly provider: SpeechProvider
  readonly lifetime: AbortController
  readonly pending: Set<Promise<Transcript>>
  readonly unsubscribe: () => void
  removal?: Promise<void>
}

/** Registry shared by all transcription consumers in one Host composition. */
export default class SpeechToText extends Service {
  static Config = z.object({
    defaultProvider: z.string().min(1).required().volatile(),
    language: z.string().min(1).default('auto').volatile(),
  })

  private readonly providers = new Map<SpeechProviderId, Registration>()
  private readonly removals = new Set<Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  /** Persisted selection owned by the current optional Settings binding. */
  private scope: SettingsScope<SpeechSelectionSection> | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'speechToText')
    ctx.on('loader/volatile-update', () => { this.changed() })
    ctx.effect(() => {
      const binding = ctx.inject(['settings'], (sctx) => {
        const scope = sctx.settings.register('speech-to-text', z.object({
          defaultProvider: z.string().min(1).required(),
          language: z.string().min(1).required(),
        }), {
          base: { defaultProvider: this.config.defaultProvider.get(), language: this.config.language.get() },
          label: { zh: '语音识别', en: 'Speech recognition' },
        })
        sctx.effect(() => scope.watch(() => { this.changed() }))
        sctx.effect(() => {
          this.scope = scope
          return () => {
            if (this.scope === scope) { this.scope = undefined; this.changed() }
          }
        })
        this.changed()
      })
      return binding.dispose
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Speech service disposed'))
      for (const registration of [...this.providers.values()]) void this.remove(registration)
      const results = await Promise.allSettled(this.removals)
      this.listeners.clear()
      const errors: unknown[] = []
      for (const outcome of results) if (outcome.status === 'rejected') errors.push(outcome.reason)
      if (errors.length) throw new AggregateError(errors, 'Speech provider cleanup failed')
    })
  }

  /**
   * Register one recognizer; duplicate ids fail without replacing the original.
   * @param provider - recognizer owned by the contributing fiber.
   * @returns idempotent disposer which rejects admission, cancels, and joins accepted work.
   */
  register(provider: SpeechProvider): () => Promise<void> {
    this.lifetime.signal.throwIfAborted()
    if (this.providers.has(provider.info.id)) throw new Error(`Speech provider already registered: ${provider.info.id}`)
    const registration: Registration = { provider, lifetime: new AbortController(), pending: new Set(),
      unsubscribe: provider.preparation?.subscribe(() => { this.changed() }) ?? (() => {}) }
    this.providers.set(provider.info.id, registration)
    this.changed()
    return async () => { await this.remove(registration) }
  }

  private remove(registration: Registration): Promise<void> {
    if (registration.removal !== undefined) return registration.removal
    const removal = Promise.withResolvers<void>()
    registration.removal = removal.promise
    this.removals.add(removal.promise)
    void this.closeRegistration(registration).then(() => {
      this.removals.delete(removal.promise)
      removal.resolve(undefined)
    }, (error: unknown) => {
      this.removals.delete(removal.promise)
      removal.reject(error)
    })
    return removal.promise
  }

  private async closeRegistration(registration: Registration): Promise<void> {
    this.providers.delete(registration.provider.info.id)
    try { registration.unsubscribe() }
    finally {
      this.changed()
      registration.lifetime.abort(new Error('Speech provider unloaded'))
      await Promise.allSettled(registration.pending)
    }
  }

  /**
   * Read the current recognizer roster.
   * @returns available provider facts in registration order.
   */
  listProviders(): readonly SpeechProviderInfo[] {
    return [...this.providers.values()].map(({ provider }) => provider.info)
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  /**
   * Observe complete readiness snapshots; a slow reader coalesces intermediate progress.
   * @param caller - observer lifetime, independent of any preparation task.
   * @returns an initial snapshot followed by the latest provider states.
   */
  async *follow(caller: AbortSignal): AsyncIterable<SpeechSnapshot> {
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    signal.throwIfAborted()
    let wake = Promise.withResolvers<undefined>()
    let changed = true
    const aborted = (): boolean => signal.aborted
    const notify = (): void => { changed = true; wake.resolve(undefined) }
    this.listeners.add(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!aborted()) {
        if (!changed) await wake.promise
        if (aborted()) break
        wake = Promise.withResolvers<undefined>(); changed = false
        yield this.snapshot()
      }
    } finally {
      this.listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  /**
   * Read provider readiness and current user preferences together.
   * @returns one detached complete observation.
   */
  snapshot(): SpeechSnapshot {
    const section = this.scope?.get()
    return { providers: [...this.providers.values()].map(({ provider }) => ({ ...provider.info,
      preparation: provider.preparation?.snapshot() ?? { phase: 'ready' },
    })), selection: { providerId: (section?.defaultProvider ?? this.config.defaultProvider.get()) as SpeechProviderId,
      language: section?.language ?? this.config.language.get() } }
  }

  /**
   * Persist changed selection fields into the `speech-to-text` settings section; the resulting
   * language must be accepted by the selected provider.
   * @param patch - explicit provider or language changes.
   * @returns after the settings write commits under the current binding.
   * @throws when the Settings binding changes during the write; committed file data is retained.
   */
  async configure(patch: SpeechSelectionPatch): Promise<void> {
    const scope = this.scope
    if (scope === undefined) throw new Error('Speech selection requires the settings service')
    const current = this.snapshot().selection
    this.selectedProvider(patch.providerId ?? current.providerId, patch.language ?? current.language)
    await scope.update({ ...patch.providerId === undefined ? {} : { defaultProvider: patch.providerId },
      ...patch.language === undefined ? {} : { language: patch.language } })
    if (this.scope !== scope) throw new Error('Speech settings provider changed while saving preferences')
  }

  private selectedProvider(id: SpeechProviderId, language: string): SpeechProvider {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    if (!registration.provider.info.languages.includes(language)) {
      throw new Error(`Speech provider ${id} does not support language: ${language}`)
    }
    return registration.provider
  }

  /**
   * Start or join provider-owned preparation.
   * @param id - exact registered provider identity.
   * @param options - task-local source selection validated by the provider.
   */
  prepare(id: SpeechProviderId, options?: SpeechPreparationOptions): void {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    registration.provider.preparation?.prepare(options)
  }

  /**
   * Explicitly cancel provider preparation without tying it to a browser connection.
   * @param id - exact registered provider identity.
   * @returns after the preparation task settles.
   */
  async cancelPreparation(id: SpeechProviderId): Promise<void> {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    await registration.provider.preparation?.cancel()
  }

  /**
   * Apply composition defaults and capture the selected provider. Missing providers and unsupported languages fail explicitly.
   * @param request - complete recording and optional selection.
   * @returns provider-pinned input for transcribe().
   */
  resolve(request: SpeechRequest): SpeechSpec {
    const current = this.snapshot().selection
    const id = request.providerId ?? current.providerId
    const language = request.language ?? current.language
    return { provider: this.selectedProvider(id, language), audio: request.audio, language }
  }

  /**
   * Execute exactly the resolved provider; no fallback sends audio elsewhere.
   * @param spec - resolved input; a withdrawn or replaced registration is rejected.
   * @param signal - caller cancellation.
   * @returns final transcript after provider settlement.
   */
  async transcribe(spec: SpeechSpec, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted()
    const registration = this.providers.get(spec.provider.info.id)
    if (registration?.provider !== spec.provider) throw new Error('Resolved speech provider is no longer registered')
    const combined = AbortSignal.any([signal, registration.lifetime.signal])
    const pending = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return spec.provider.transcribe({ audio: spec.audio, language: spec.language }, combined)
    })
    registration.pending.add(pending)
    try {
      const result = await pending
      combined.throwIfAborted()
      return result
    } finally {
      registration.pending.delete(pending)
    }
  }
}
