/** Test-local stand-in for the fork-absent DeepSeek-account provider surface. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Dict } from '@deepseek-ai/cosmokit'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { catalogModelInfo, deepSeekConfigFields, plainOptions, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { Config as DeepSeekConfig, ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

export const name = 'llm-deepseek-account'
export const inject = ['llm']

const PROVIDER = 'deepseek-account'

/**
 * Account-side token authority a real account provider would own. The fixture
 * mounts it as a host service; resolveToken returning undefined mirrors a
 * signed-out account.
 */
interface DeepSeekAccountStub {
  resolveToken(baseURL: string): Promise<string | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    deepseekAccount?: DeepSeekAccountStub
  }
}

/** Account connection options plus the remote-listing overrides the translator reads. */
export const Config = z.object({
  ...deepSeekConfigFields,
  modelOverrides: z.dict(z.any()).default({}).volatile(),
})

/** Resolved Config as the Loader hands it to `apply`: validated fields, each wrapped Volatile. */
export interface Config extends DeepSeekConfig {
  readonly modelOverrides: Volatile<Dict>
}

/** Settings namespace a GUI would use; the paid fixture only needs directory identity. */
const NS = settingsNamespace('llm-deepseek-account')

/**
 * Composed under the Loader name `@deepseek-ai/dsh-llm-deepseek-account`, this
 * gives the translator's `deepseek-account` route the same Messages wire the
 * excluded upstream provider carried: token auth, remote model listing, and a
 * settings namespace keyed by the Loader entry id.
 * @param ctx - provider plugin lifetime with the LLM registry injected.
 * @param config - connection fields plus catalog overrides.
 */
export function apply(ctx: Context, config: Config): void {
  const options = (): ResolvedDeepSeekOptions => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx))
  options()
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'DeepSeek Account',
    settingsNs: ctx.fiber.entry?.options.id ?? NS, settingsPath: [] }])
  registerDeepSeekProvider(ctx, PROVIDER, {
    options,
    providerName: 'DeepSeek Account',
    resolveAuth: async (connection) => {
      const token = await ctx.get('deepseekAccount')?.resolveToken(connection.baseURL)
      return { headers: token === undefined ? {} : { 'x-dsh-auth-token': token } }
    },
    discoverModels: async (provider) => {
      const connection = options()
      const token = await ctx.get('deepseekAccount')?.resolveToken(connection.baseURL)
      if (token === undefined) return []
      const response = await fetch(new URL('/models', connection.baseURL + '/'), {
        headers: { 'x-dsh-auth-token': token }, signal: AbortSignal.timeout(10_000),
      })
      const listed = await response.json() as { data: { id: string; name: string; api_capabilities?: Record<string, unknown> }[] }
      return listed.data.map(model => catalogModelInfo(provider, model))
    },
  })
}
