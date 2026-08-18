import {
  AdminRequestError,
  describeOrganizationCredentials,
  describeOrganizationModelSettings,
  discoverOrganizationModels,
  listModelProviders,
  mutateOrganizationModelSettings,
  setOrganizationCredential,
  unsetOrganizationCredential,
  type OrganizationModelSettingsView,
} from './api.ts'

type RpcErrorCode =
  | 'credential-rejected'
  | 'internal'
  | 'model-discovery-failed'
  | 'settings-conflict'
  | 'settings-not-exposed'
  | 'settings-rejected'

type RpcEnvelope<T> = {
  rpcId: never
  result:
    | { ok: true; value: T }
    | { ok: false; error: { code: RpcErrorCode; message: string; details: Record<string, unknown> } }
}

let rpcSequence = 0

function rpcId(): never {
  rpcSequence += 1
  return `admin-model-settings-${String(rpcSequence)}` as never
}

function accepted<T>(value: T): RpcEnvelope<T> {
  return { rpcId: rpcId(), result: { ok: true, value } }
}

function rejected<T>(
  code: RpcErrorCode,
  message: string,
  details: Record<string, unknown>,
): RpcEnvelope<T> {
  return { rpcId: rpcId(), result: { ok: false, error: { code, message, details } } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} is not an object`)
  }
  return value as Record<string, unknown>
}

function namespaceOf(view: OrganizationModelSettingsView) {
  const namespace = view.namespaces.find(candidate => candidate.ns === 'llm-pi-ai')
  if (namespace === undefined) throw new Error('organization model settings namespace is unavailable')
  return namespace
}

function profilesOf(view: OrganizationModelSettingsView): Record<string, Record<string, unknown>> {
  const root = objectAt(namespaceOf(view).value, 'organization model settings')
  const providers = objectAt(root.providers, 'organization model settings.providers')
  return Object.fromEntries(Object.entries(providers).map(([provider, profile]) => [
    provider,
    objectAt(profile, `organization provider ${provider}`),
  ]))
}

function modelRows(profile: Record<string, unknown>): Array<{ id: string; name: string }> {
  if (!Array.isArray(profile.models)) return []
  const rows: Array<{ id: string; name: string }> = []
  for (const raw of profile.models) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const model = raw as Record<string, unknown>
    if (typeof model.id !== 'string' || model.id.length === 0) continue
    rows.push({
      id: model.id,
      name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
    })
  }
  return rows
}

function settingsFailure(
  error: unknown,
  expectedRevision: number | undefined,
): Promise<RpcEnvelope<never>> | RpcEnvelope<never> {
  if (error instanceof AdminRequestError && error.status === 409 && error.message === 'settings-conflict') {
    return describeOrganizationModelSettings().then((current) => rejected<never>(
      'settings-conflict',
      error.message,
      {
        ns: 'llm-pi-ai',
        expected: expectedRevision ?? 0,
        actual: namespaceOf(current).revision,
      },
    )).catch(() => rejected<never>(
      'settings-conflict',
      error.message,
      { ns: 'llm-pi-ai', expected: expectedRevision ?? 0, actual: expectedRevision ?? 0 },
    ))
  }
  return rejected<never>('settings-rejected', messageOf(error), { ns: 'llm-pi-ai' })
}

/** Optional notification after a successful organization model write. */
export interface OrganizationModelsApiOptions {
  onChanged?: () => void
}

/** REST-backed wire facade consumed by the shared Models settings plugin. */
export function createOrganizationModelsApi(options: OrganizationModelsApiOptions = {}) {
  return {
    settings: {
      async describe() {
        try {
          return accepted(await describeOrganizationModelSettings())
        } catch (error) {
          return rejected('internal', messageOf(error), {})
        }
      },
      async mutate(payload: {
        ns: string
        ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>
        expectedRevision?: number
      }) {
        if (payload.ns !== 'llm-pi-ai') {
          return rejected('settings-not-exposed', `settings namespace ${payload.ns} is not exposed`, { ns: payload.ns })
        }
        try {
          const view = await mutateOrganizationModelSettings({
            ops: payload.ops,
            ...payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision },
          })
          options.onChanged?.()
          return accepted(namespaceOf(view))
        } catch (error) {
          return await settingsFailure(error, payload.expectedRevision)
        }
      },
    },
    credentials: {
      async describe(payload: { refs: string[] }) {
        try {
          return accepted(await describeOrganizationCredentials(payload.refs))
        } catch (error) {
          return rejected('internal', messageOf(error), {})
        }
      },
      async set(payload: { ref: string; value: string }) {
        try {
          await setOrganizationCredential(payload.ref, payload.value)
          options.onChanged?.()
          return accepted({})
        } catch (error) {
          return rejected('credential-rejected', messageOf(error), { ref: payload.ref })
        }
      },
      async unset(payload: { ref: string }) {
        try {
          await unsetOrganizationCredential(payload.ref)
          options.onChanged?.()
          return accepted({})
        } catch (error) {
          return rejected('credential-rejected', messageOf(error), { ref: payload.ref })
        }
      },
    },
    llm: {
      async providers() {
        try {
          const [view, rows] = await Promise.all([
            describeOrganizationModelSettings(),
            listModelProviders(),
          ])
          const active = new Map(rows
            .filter(row => row.source === 'managed')
            .map(row => [row.provider, row.status === 'enabled']))
          const providers = Object.entries(profilesOf(view)).map(([provider, profile]) => ({
            provider,
            displayName: typeof profile.displayName === 'string' && profile.displayName.length > 0
              ? profile.displayName
              : provider,
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', provider],
            active: active.get(provider) === true,
            management: 'organization' as const,
            declared: true,
          }))
          return accepted({ providers })
        } catch (error) {
          return rejected('internal', messageOf(error), {})
        }
      },
      async models() {
        try {
          const profiles = profilesOf(await describeOrganizationModelSettings())
          return accepted({
            groups: Object.entries(profiles).map(([provider, profile]) => ({
              id: provider,
              name: typeof profile.displayName === 'string' && profile.displayName.length > 0
                ? profile.displayName
                : provider,
              models: modelRows(profile),
            })),
            failures: [],
          })
        } catch (error) {
          return rejected('internal', messageOf(error), {})
        }
      },
      async discoverModels(payload: {
        settingsNs: string
        provider?: string
        baseURL?: string
        api?: string
        apiKey?: string
      }) {
        if (payload.settingsNs !== 'llm-pi-ai') {
          return rejected(
            'model-discovery-failed',
            `settings namespace ${payload.settingsNs} has no organization model discovery`,
            { settingsNs: payload.settingsNs, ...payload.baseURL === undefined ? {} : { baseURL: payload.baseURL } },
          )
        }
        try {
          const { settingsNs: _settingsNs, ...request } = payload
          return accepted(await discoverOrganizationModels(request))
        } catch (error) {
          return rejected(
            'model-discovery-failed',
            messageOf(error),
            { settingsNs: payload.settingsNs, ...payload.baseURL === undefined ? {} : { baseURL: payload.baseURL } },
          )
        }
      },
    },
  }
}

/** Structural facade type used by the admin editor wrapper and its tests. */
export type OrganizationModelsApi = ReturnType<typeof createOrganizationModelsApi>
