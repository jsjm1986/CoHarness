/**
 * Loader composition for the login-cancellation regressions: real
 * `dsh-credentials-local` (extended with a post-admission write gate) plus the
 * real `dsh-authorization`, with a probe plugin registering one flow that runs
 * the actual `Models.login` against a controlled OAuth provider. Private root,
 * `Loader.await()` readiness, and an owner for env-independent teardown.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { Provider } from '@earendil-works/pi-ai'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from '../../src/auth.ts'
import { loginCollectionFor } from '../../src/login.ts'

/** Local credentials with test gates at enrollment and after admission. */
class GatedCredentials extends LocalCredentialProvider {
  /** Called as a `modifyRecord` call joins the provider's operation chain. */
  onEnqueued?: (key: CredentialKey) => void
  /** Called after a mutation is admitted, before the record reaches disk. */
  afterAdmission?: () => Promise<void>

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.onEnqueued?.(key)
    return super.modifyRecord(key, async (current) => {
      const next = await mutate(current)
      if (next !== undefined) await this.afterAdmission?.()
      return next
    })
  }
}

export interface LoginComposition {
  readonly ctx: Context
  /** The credentials provider, for gating and record inspection. */
  readonly credentials: GatedCredentials
  /** Absolute path of the durable credentials document. */
  readonly credentialsFile: string
  dispose(): Promise<void>
}

/**
 * Boot credentials-local + authorization + one flow that runs the real
 * `Models.login` for `providerId` against the supplied provider.
 * @param provider - the controlled pi-ai provider whose `oauth.login` is under test control.
 * @param providerId - the provider/record id the flow owns.
 */
export async function loadLoginComposition(
  provider: Provider,
  providerId: string,
): Promise<LoginComposition> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pi-login-lifecycle-'))
  const credentialsFile = join(root, '.credentials.yaml')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsFile)}`,
    '    watch: false',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: login-flow',
    '  name: login-flow',
    '',
  ].join('\n'))

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  const flow = {
    name: 'login-flow',
    inject: ['authorization'],
    apply(flowCtx: Context): void {
      flowCtx.authorization.registerFlow({
        key: recordKeyFor(providerId),
        label: 'probe login',
        methods: [{ id: 'oauth', label: 'probe oauth' }],
        async run(session) {
          const models = loginCollectionFor(flowCtx, {
            credentials: credentialStoreFrom(flowCtx),
            authContext: authContextFrom(flowCtx),
          }, session, providerId)
          models.setProvider(provider)
          await models.login(providerId, 'oauth', {
            signal: session.signal,
            notify: () => {},
            prompt: () => Promise.reject(new Error('unused')),
          })
        },
      })
    },
  }
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-credentials-local', GatedCredentials],
      ['@deepseek-ai/dsh-authorization', AuthorizationService],
      ['login-flow', flow],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return {
    ctx,
    credentials: ctx.credentials as GatedCredentials,
    credentialsFile,
    dispose: async () => {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}
