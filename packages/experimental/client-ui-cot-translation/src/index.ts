/** Host access to machine translation of displayed reasoning. */
import { addAbortListener } from 'node:events'
import { Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-api-remotes/session-controller'
import { TranslationError } from '@deepseek-ai/dsh-experimental-translator'
import type { TranslationRequest, TranslationSpec } from '@deepseek-ai/dsh-experimental-translator/types'
import { LANGUAGE_PREFERENCE_PATTERN, PROVIDER_PREFERENCES } from './preferences.ts'
import type { CotTranslationPreferences, CotTranslationSnapshot } from './types.ts'

const preferencesSchema: z<CotTranslationPreferences> = z.object({
  provider: z.union(PROVIDER_PREFERENCES).default('bing'),
  targetLanguage: z.string().pattern(LANGUAGE_PREFERENCE_PATTERN).default('auto'),
})

/** Live preferences presented on the bundle's Plugins page. */
export interface Config {
  /** Explicit translation provider, defaulting to Bing. */
  provider: Volatile<CotTranslationPreferences['provider']>
  /** Target language code; auto follows the browser UI locale. */
  targetLanguage: Volatile<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote consumer of the experimental translation service. */
    cotTranslation: CotTranslationController
  }
}

/** Optional reasoning translation delegates Session-bound storage to the translator. */
export default class CotTranslationController extends TypertRemoteService {
  static inject = ['translator', 'typert', 'sessionController']
  static Config = z.object({
    provider: z.union(PROVIDER_PREFERENCES).default('bing').volatile(),
    targetLanguage: z.string().pattern(LANGUAGE_PREFERENCE_PATTERN).default('auto').volatile(),
  })

  private preferences: () => CotTranslationPreferences

  constructor(ctx: Context, config: Config) {
    super(ctx, 'cotTranslation', { namespace: 'cotTranslation' })
    const entry = {
      get provider() { return config.provider.get() },
      get targetLanguage() { return config.targetLanguage.get() },
    }
    this.preferences = () => entry
    installSettingsSection(ctx, settingsNamespace('cot-translation'), preferencesSchema, entry, {
      label: { en: 'Reasoning translation', zh: '思考翻译' },
      setSource: (source) => { this.preferences = source },
      onChange: () => { /* Requests and limits read the accepted preferences directly. */ },
    })
  }

  /**
   * Read accepted translation preferences and the current request limit without sending text.
   * @param signal - browser query cancellation or Remote contribution withdrawal.
   * @returns authoritative preferences, eligible routes, and maximum UTF-16 text length per request.
   */
  @Remote
  async limits(signal: AbortSignal): Promise<CotTranslationSnapshot> {
    signal.throwIfAborted()
    const availableProviders = await this.ctx.translator.availableProviders(signal)
    signal.throwIfAborted()
    return { maxTextChars: this.ctx.translator.maxTextChars,
      preferences: this.preferences(), availableProviders }
  }

  /**
   * Translate one displayed fragment through the reader's selected provider.
   * @param request - original text and Session identity supplied by the Client; provider and explicit
   * target language match accepted preferences, while auto uses the browser locale.
   * @param signal - browser cancellation or Remote contribution withdrawal.
   * @returns translated text; an uncached inactive Session joins ordinary GUI activation before retry.
   * Failures omit the source and provider response. Cancellation stops this caller's wait, not shared activation.
   */
  @Remote
  async translate(request: TranslationRequest, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    try {
      const spec = this.resolveSelected(request)
      try {
        return await this.ctx.translator.translate(spec, signal)
      } catch (error) {
        if (!(error instanceof TranslationError) || error.code !== 'TRANSLATION_SESSION_INACTIVE' || spec.sessionId === undefined) throw error
      }
      signal.throwIfAborted()
      const activation = this.ctx.sessionController.resolveAgent(spec.sessionId).then((result) => {
        if ('error' in result) throw new Error(result.error.message)
      }).catch((error: unknown) => {
        if (signal.aborted) this.ctx.logger.warn('Reasoning translation Session activation failed after cancellation')
        throw error
      })
      const cancelled = Promise.withResolvers<never>()
      using _listener = addAbortListener(signal, () => { cancelled.reject(signal.reason) })
      await Promise.race([activation, cancelled.promise])
      signal.throwIfAborted()
      return await this.ctx.translator.translate(this.resolveSelected(spec), signal)
    } catch (_error) {
      signal.throwIfAborted()
      throw new RemoteError('cotTranslation/failed', 'Translation failed', {})
    }
  }

  private resolveSelected(request: TranslationRequest): TranslationSpec {
    const { provider: accepted, targetLanguage } = this.preferences()
    const provider = request.provider ?? accepted
    if (provider !== accepted) throw new Error('Translation provider is not selected')
    if (targetLanguage !== 'auto' && request.targetLanguage !== targetLanguage) throw new Error('Translation language is not selected')
    return this.ctx.translator.resolve({ ...request, provider })
  }
}
