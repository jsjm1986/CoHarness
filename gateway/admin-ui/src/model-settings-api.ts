import { SettingsDescribeMirror } from '../../../packages/client/ui-settings/src/client/settings-mirror.ts'
import type { SettingsDescribeFace } from '../../../packages/client/ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../../../packages/client/ui-settings-models/src/client/store.ts'
import type { SettingsSchemaOperations } from '../../../packages/client/ui-settings-models/src/client/schema-operations.ts'
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

async function settingsFailure(
  error: unknown,
  expectedRevision: number | undefined,
  readSettings: () => Promise<OrganizationModelSettingsView>,
): Promise<RpcEnvelope<never>> {
  if (error instanceof AdminRequestError && error.status === 409 && error.message === 'settings-conflict') {
    let actual = expectedRevision ?? 0
    try {
      actual = namespaceOf(await readSettings()).revision
    } catch {
      // Failed or cancelled recovery cannot supply a newer revision.
    }
    return rejected<never>(
      'settings-conflict',
      error.message,
      { ns: 'llm-pi-ai', expected: expectedRevision ?? 0, actual },
    )
  }
  return rejected<never>('settings-rejected', messageOf(error), { ns: 'llm-pi-ai' })
}

/** Page lifetime and successful-write notification for one organization editor. */
export interface OrganizationModelsApiOptions {
  /** Called after a successful write; omission sends no notification. */
  onChanged?: () => void
  /** Page-owned lifetime; omission leaves pending reads uncancelled by a page owner. */
  signal?: AbortSignal
}

/**
 * REST facade sharing only pending settings reads; writes and settlement release the shared slot.
 * @param options - optional page lifetime and successful-write notification.
 * @returns independent readers sharing this facade's pending settings request.
 */
export function createOrganizationModelsApi(options: OrganizationModelsApiOptions = {}) {
  let settingsRead: Promise<OrganizationModelSettingsView> | undefined
  const readSettings = (): Promise<OrganizationModelSettingsView> => {
    options.signal?.throwIfAborted()
    if (settingsRead !== undefined) return settingsRead
    const reading = describeOrganizationModelSettings(options.signal).then(view => {
      options.signal?.throwIfAborted()
      return view
    })
    settingsRead = reading
    const release = (): void => { if (settingsRead === reading) settingsRead = undefined }
    void reading.then(release, release)
    return reading
  }
  return {
    /** Begin a fresh page-read round without cancelling earlier consumers. */
    beginRead(): void { settingsRead = undefined },
    settings: {
      async describe() {
        try {
          const view = await readSettings()
          options.signal?.throwIfAborted()
          return accepted(view)
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
        settingsRead = undefined
        try {
          const view = await mutateOrganizationModelSettings({
            ops: payload.ops,
            ...payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision },
          })
          settingsRead = undefined
          options.onChanged?.()
          return accepted(namespaceOf(view))
        } catch (error) {
          settingsRead = undefined
          return await settingsFailure(error, payload.expectedRevision, readSettings)
        }
      },
    },
    credentials: {
      async describe(payload: { refs: string[] }) {
        try {
          options.signal?.throwIfAborted()
          const view = await describeOrganizationCredentials(payload.refs, options.signal)
          options.signal?.throwIfAborted()
          return accepted(view)
        } catch (error) {
          return rejected('internal', messageOf(error), {})
        }
      },
      async set(payload: { ref: string; value: string }) {
        settingsRead = undefined
        try {
          await setOrganizationCredential(payload.ref, payload.value)
          settingsRead = undefined
          options.onChanged?.()
          return accepted({})
        } catch (error) {
          settingsRead = undefined
          return rejected('credential-rejected', messageOf(error), { ref: payload.ref })
        }
      },
      async unset(payload: { ref: string }) {
        settingsRead = undefined
        try {
          await unsetOrganizationCredential(payload.ref)
          settingsRead = undefined
          options.onChanged?.()
          return accepted({})
        } catch (error) {
          settingsRead = undefined
          return rejected('credential-rejected', messageOf(error), { ref: payload.ref })
        }
      },
    },
    llm: {
      async providers() {
        try {
          const [view, rows] = await Promise.all([
            readSettings(),
            listModelProviders(options.signal),
          ])
          options.signal?.throwIfAborted()
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
          const view = await readSettings()
          options.signal?.throwIfAborted()
          const profiles = profilesOf(view)
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
          return rejected<never>(
            'model-discovery-failed',
            `settings namespace ${payload.settingsNs} has no organization model discovery`,
            { settingsNs: payload.settingsNs, ...payload.baseURL === undefined ? {} : { baseURL: payload.baseURL } },
          )
        }
        try {
          options.signal?.throwIfAborted()
          const { settingsNs: _settingsNs, ...request } = payload
          const view = await discoverOrganizationModels(request, options.signal)
          options.signal?.throwIfAborted()
          return accepted(view)
        } catch (error) {
          return rejected<never>(
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

/** Organization page reads keep each explicit refresh independent of an earlier pending read. */
export class OrganizationModelsStore extends ModelsSettingsStore {
  /**
   * @param rest - facade owned by the mounted organization editor.
   * @param schema - synchronous schema operations used to build rows.
   * @param describeFace - existing settings mirror, including its queued refresh semantics.
   */
  constructor(
    private readonly rest: OrganizationModelsApi,
    schema: SettingsSchemaOperations,
    describeFace: SettingsDescribeFace,
  ) {
    super(rest as never, schema, describeFace)
  }

  /** @returns settlement after the latest refresh publishes its ready or error snapshot. */
  override load(): Promise<void> {
    this.rest.beginRead()
    return super.load()
  }
}

/**
 * Settings mirror plus folded facade pair for the organization editor.
 * Organization settings and credential writes share one server-side
 * revision, so every write answer must fold through the mirror: a stale
 * `namespace.revision` makes the next mutate self-conflict with a 409.
 * @param options - facade options; `onChanged` fires per successful write.
 * @returns the describe face and the api the editor should consume.
 */
export function createOrganizationModelsMirror(options: OrganizationModelsApiOptions = {}) {
  const rest = createOrganizationModelsApi(options)
  const describeFace = new SettingsDescribeMirror(rest as never)
  const api: OrganizationModelsApi = {
    ...rest,
    settings: {
      describe: rest.settings.describe,
      async mutate(payload) {
        const response = await rest.settings.mutate(payload)
        if (response.result.ok) describeFace.acceptView(response.result.value as Parameters<SettingsDescribeMirror['acceptView']>[0])
        else if (response.result.error.code === 'settings-conflict') void describeFace.load()
        return response
      },
    },
    credentials: {
      describe: rest.credentials.describe,
      async set(payload) {
        const response = await rest.credentials.set(payload)
        if (response.result.ok) void describeFace.load()
        return response
      },
      async unset(payload) {
        const response = await rest.credentials.unset(payload)
        if (response.result.ok) void describeFace.load()
        return response
      },
    },
  }
  return { describeFace, api }
}
