/** Generated Remote codecs and one-shot installation streams over the administrator API. */
import { randomUUID } from '../../../../packages/util/crypto/src/index.ts'
import type { ClientRemote } from '../../../../packages/api/remotes/lib/types/client/index.d.ts'
import managerContribution from '../../../../packages/boot/plugin-manager/lib/typert.remote-client.js'
import inventoryContribution from '../../../../packages/host/plugin-inventory/lib/typert.remote-client.js'
import { readRpcStream } from '../../../../packages/client/connection/src/rpc-stream-reader.ts'
import type { ChangeResult, PluginInstallFrame } from '../../../../packages/boot/plugin-manager/src/types.ts'
import { settingsDescribeValueSchema, settingsMutateValueSchema } from '../../../../packages/host/apiproxy/src/api/settings.schema.ts'
import type { SettingsNamespaceView, SettingsPathOpView } from '../../../../packages/host/apiproxy/src/api/settings.ts'
import { AdminRequestError, pluginManagementInvoke, type PluginManagementTarget } from '../api.ts'
import { adminLanguage } from '../language.ts'
import { translatePlugin } from './presentation.ts'

type Answers<Methods> = { [K in keyof Methods]: Methods[K] extends (...args: infer Args) => Promise<{ ok: true; value: infer Value } | { ok: false; error: unknown }> ? (...args: Args) => Promise<Answer<Value>> : never }
export interface ProfileSettingsRemote {
  describe(): Promise<Answer<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>>
  mutate(input: { ns: string; ops: SettingsPathOpView[]; expectedRevision: number }): Promise<Answer<SettingsNamespaceView>>
}
export interface PluginManagementRemote {
  settings: ProfileSettingsRemote
  pluginManager: Answers<Pick<ClientRemote['pluginManager'], 'listPlugins' | 'listBundles' | 'inspect' | 'setPluginEnabled' | 'setBundleEnabled' | 'installBundle' | 'cancelInstall' | 'removeBundle' | 'registries' | 'waitForInstall'>>
  pluginInventory: Answers<Pick<ClientRemote['pluginInventory'], 'list'>>
  /** The gateway answers it locally; the managed runtime carries no such service. */
  pluginRegistryProbe: { fastest(): Promise<Answer<string | null>> }
}
export type Answer<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
const refused = (message: string): Answer<never> => ({ ok: false, error: { code: 'admin/management-interrupted', message } })
const messageOf = (error: unknown) => error instanceof Error ? error.message : translatePlugin(adminLanguage())('wireUnconfirmed')

function decode<T>(endpoint: string, value: unknown): T {
  const t = translatePlugin(adminLanguage())
  if (endpoint === 'pluginRegistryProbe/fastest') {
    if (value !== null && typeof value !== 'string') throw new Error(t('wireProbeInvalid'))
    return value as T
  }
  if (endpoint === 'settings.describe') return settingsDescribeValueSchema.parse(value) as T
  if (endpoint === 'settings.mutate') return settingsMutateValueSchema.parse(value) as T
  const descriptor = [...managerContribution.descriptors, ...inventoryContribution.descriptors]
    .find(item => `${item.namespace}/${item.method}` === endpoint)
  if (descriptor?.result.mode !== 'strict') throw new Error(t('wireNoValidator'))
  return descriptor.result.create().parse(value) as T
}

/** Bind every request to the selected node and generation; installation streams never reconnect or replay effects. */
export function pluginManagementRemote(target: PluginManagementTarget, lifetime: AbortSignal, progress: (frame: PluginInstallFrame) => void, invalidate: (message: string) => void): PluginManagementRemote {
  const interrupted = (error: unknown) => {
    if (!lifetime.aborted && error instanceof AdminRequestError && [401, 403, 404, 409].includes(error.status)) invalidate(messageOf(error))
    return refused(messageOf(error))
  }
  const remoteFailure = (error: { message: string; code?: unknown }) => {
    if (!lifetime.aborted && (error.code === 'plugin-management/forbidden' || error.code === 'collaboration-forbidden')) invalidate(error.message)
    return { ok: false as const, error: { code: typeof error.code === 'string' ? error.code : 'admin/management-interrupted', message: error.message } }
  }
  const t = () => translatePlugin(adminLanguage())
  const request = (endpoint: string, args: object) => ({ ...target, rpcId: randomUUID(), endpoint, args })
  const call = async <T,>(endpoint: string, args: object, signal?: AbortSignal): Promise<Answer<T>> => {
    const input = request(endpoint, args)
    try {
      const value = await pluginManagementInvoke(input, signal === undefined ? lifetime : AbortSignal.any([lifetime, signal]))
      if (typeof value !== 'object' || value === null || !('rpcId' in value) || value.rpcId !== input.rpcId || !('result' in value)) throw new Error(t()('wireMismatched'))
      const result = value.result
      if (typeof result !== 'object' || result === null || !('ok' in result)) throw new Error(t()('wireNoResult'))
      if (result.ok === false && 'error' in result && typeof result.error === 'object' && result.error !== null && 'message' in result.error && typeof result.error.message === 'string') return remoteFailure({ message: result.error.message, code: 'code' in result.error ? result.error.code : undefined })
      if (result.ok !== true || !('value' in result)) throw new Error(t()('wireInvalid'))
      return { ok: true, value: decode<T>(endpoint, result.value) }
    } catch (error) { return interrupted(error) }
  }
  return {
    settings: { describe: () => call('settings.describe', {}), mutate: input => call('settings.mutate', input) },
    pluginInventory: { list: () => call('pluginInventory/list', {}) },
    pluginRegistryProbe: { fastest: () => call('pluginRegistryProbe/fastest', {}) },
    pluginManager: {
      listPlugins: () => call('pluginManager/listPlugins', {}),
      listBundles: () => call('pluginManager/listBundles', {}),
      inspect: (spec, options, signal) => call('pluginManager/inspect', { spec, options }, signal),
      setPluginEnabled: (id, enabled) => call('pluginManager/setPluginEnabled', { id, enabled }),
      setBundleEnabled: (name, enabled) => call('pluginManager/setBundleEnabled', { name, enabled }),
      removeBundle: (name, signal) => call('pluginManager/removeBundle', { name }, signal),
      cancelInstall: requestId => call('pluginManager/cancelInstall', { requestId }),
      registries: () => call('pluginManager/registries', {}),
      waitForInstall: requestId => call('pluginManager/waitForInstall', { requestId }),
      async installBundle(spec, options, signal) {
        const input = request('pluginManager/installBundleStream', { spec, options })
        const abort = signal === undefined ? lifetime : AbortSignal.any([lifetime, signal])
        let final: ChangeResult | undefined
        try {
          for await (const answer of readRpcStream(async (_url, init) => {
            const response = await fetch('/admin/api/plugins/invoke', {
              ...init, credentials: 'same-origin', body: JSON.stringify(input),
            })
            if ([401, 403, 404, 409].includes(response.status)) {
              await response.body?.cancel()
              if (!lifetime.aborted) invalidate(t()('wireStale'))
              throw new Error(t()('wireStale'))
            }
            return response
          }, new URL('/admin/api/plugins/invoke', location.origin), input, abort)) {
            if (!answer.ok) return remoteFailure(answer.error)
            const frame = decode<PluginInstallFrame>(input.endpoint, answer.value)
            if (final !== undefined) throw new Error(t()('wireExtraFrame'))
            if (frame.type === 'result') final = frame.value
            else progress(frame)
          }
          if (final === undefined) throw new Error(t()('wireNoOutcome'))
          return { ok: true, value: final }
        } catch (error) { return interrupted(error) }
      },
    },
  }
}
