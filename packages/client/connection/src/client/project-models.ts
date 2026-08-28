/** Browser transport for Gateway-owned project Provider settings. */

import { readApiResponseJson } from '@deepseek-ai/dsh-host-apiproxy/client'

import type {
  DiscoveredModelView,
  SettingsNamespaceView,
} from './api.ts'

/** Redacted project model settings response. */
export interface ProjectModelSettingsView {
  projectId: number
  revision: number
  writable: boolean
  hasDocument: false
  namespaces: SettingsNamespaceView[]
  providers: ProjectModelProviderView[]
  models: { groups: ProjectModelGroup[]; failures: Array<{ id: string; name: string; message: string }> }
}

/** Project route directory row, with no credential value. */
export interface ProjectModelProviderView {
  provider: string
  runtimeProvider: string
  displayName: string
  protocol: string | null
  baseURL: string | null
  authMode: 'api-key' | 'none'
  status: 'draft' | 'enabled' | 'disabled' | 'archived'
  credentialRef: string | null
  credentialConfigured: boolean
  revision: number
  modelCount: number
  profile?: Record<string, unknown>
  models?: Array<{ id: string; name: string }>
}

/** Browser model-group projection for project-owned routes. */
export interface ProjectModelGroup {
  id: string
  name: string
  models: Array<{
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    inputModalities?: Array<'text' | 'image'>
  }>
}

/** HTTP failure retaining the Gateway project-model error code. */
export class ProjectModelSettingsRequestError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(code ?? `project model settings request failed with HTTP ${String(status)}`)
    this.name = 'ProjectModelSettingsRequestError'
  }
}

/** Project model settings HTTP operations. */
export interface ProjectModelSettingsTransport {
  get(projectId: number, signal?: AbortSignal): Promise<ProjectModelSettingsView>
  mutate(projectId: number, body: {
    ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>
    expectedRevision?: number
  }, signal?: AbortSignal): Promise<ProjectModelSettingsView>
  describeCredentials(projectId: number, refs: string[], signal?: AbortSignal): Promise<{
    credentials: Record<string, { configured: boolean; source: 'project'; writable: boolean }>
  }>
  setCredential(projectId: number, ref: string, value: string, signal?: AbortSignal): Promise<void>
  unsetCredential(projectId: number, ref: string, signal?: AbortSignal): Promise<void>
  discover(projectId: number, body: {
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }, signal?: AbortSignal): Promise<{ models: DiscoveredModelView[] }>
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid project model settings response')
  return value as Record<string, unknown>
}

function withSignal(signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? {} : { signal }
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`invalid project model settings ${name}`)
  return value
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid project model settings ${name}`)
  return value
}

function nonEmptyText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid project model settings ${name}`)
  return value
}

const PROTOCOLS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
const OWNERS = new Set(['account', 'project', 'organization', 'deployment'])
const WRITABLE_REASONS = new Set(['project', 'provider', 'organization', 'deployment', 'account'])

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name)
}

function modalities(value: unknown, name: string): Array<'text' | 'image'> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`invalid project model settings ${name}`)
  }
  const result: Array<'text' | 'image'> = []
  for (const item of value) {
    if (item === 'text') result.push('text')
    else if (item === 'image') result.push('image')
    else throw new Error(`invalid project model settings ${name}`)
  }
  return result
}

function namespace(value: unknown): SettingsNamespaceView {
  const row = object(value)
  if (typeof row.schema === 'undefined' || typeof row.value === 'undefined'
    || (row.applies !== 'live' && row.applies !== 'restart') || !Array.isArray(row.secrets)
    || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0
    || (row.writable !== undefined && typeof row.writable !== 'boolean')
    || (row.owner !== undefined && (typeof row.owner !== 'string' || !OWNERS.has(row.owner)))
    || (row.writableReason !== undefined
      && (typeof row.writableReason !== 'string' || !WRITABLE_REASONS.has(row.writableReason)))) {
    throw new Error('invalid project model settings namespace')
  }
  const secrets = row.secrets.map((secretValue) => {
    const secret = object(secretValue)
    if (!Array.isArray(secret.path) || secret.path.some(segment => typeof segment !== 'string' || segment.length === 0)
      || typeof secret.set !== 'boolean') throw new Error('invalid project model settings secret')
    const path: string[] = []
    for (const segment of secret.path) {
      if (typeof segment !== 'string' || segment.length === 0) throw new Error('invalid project model settings secret')
      path.push(segment)
    }
    return { path, set: secret.set }
  })
  const writableReason = row.writableReason === undefined
    ? undefined
    : row.writableReason as SettingsNamespaceView['writableReason']
  const owner = row.owner === undefined ? undefined : row.owner as SettingsNamespaceView['owner']
  const projectWritePaths = row.projectWritePaths === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(row.projectWritePaths)) throw new Error('invalid project model settings write paths')
      const paths: string[][] = []
      for (const pathValue of row.projectWritePaths as unknown[]) {
        if (!Array.isArray(pathValue)
          || !pathValue.every((segment: unknown): segment is string => typeof segment === 'string' && segment.length > 0)) {
          throw new Error('invalid project model settings write paths')
        }
        paths.push([...pathValue])
      }
      return paths
    })()
  return {
    ns: nonEmptyText(row.ns, 'namespace'),
    schema: row.schema,
    value: row.value,
    ...(row.base === undefined ? {} : { base: row.base }),
    ...(row.user === undefined ? {} : { user: row.user }),
    applies: row.applies,
    secrets,
    revision: row.revision,
    ...(row.writable === undefined ? {} : { writable: row.writable }),
    ...(writableReason === undefined ? {} : { writableReason }),
    ...(owner === undefined ? {} : { owner }),
    ...(projectWritePaths === undefined ? {} : { projectWritePaths }),
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`invalid project model settings ${name}`)
  return value
}

function credentialViews(value: unknown): Record<string, { configured: boolean; source: 'project'; writable: boolean }> {
  const rows = object(value)
  const result = Object.create(null) as Record<string, { configured: boolean; source: 'project'; writable: boolean }>
  for (const [ref, raw] of Object.entries(rows)) {
    const row = object(raw)
    if (typeof row.configured !== 'boolean' || row.source !== 'project' || typeof row.writable !== 'boolean') {
      throw new Error('invalid project model credential view')
    }
    result[ref] = { configured: row.configured, source: 'project', writable: row.writable }
  }
  return result
}

function providerView(value: unknown): ProjectModelProviderView {
  const row = object(value)
  const status = row.status
  const authMode = row.authMode
  if (status !== 'draft' && status !== 'enabled' && status !== 'disabled' && status !== 'archived') {
    throw new Error('invalid project model provider status')
  }
  if (authMode !== 'api-key' && authMode !== 'none') throw new Error('invalid project model provider auth mode')
  if (typeof row.credentialConfigured !== 'boolean' || typeof row.revision !== 'number'
    || !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.modelCount !== 'number'
    || !Number.isSafeInteger(row.modelCount) || row.modelCount < 0) {
    throw new Error('invalid project model provider metadata')
  }
  if (row.protocol !== null && (typeof row.protocol !== 'string' || !PROTOCOLS.has(row.protocol))) {
    throw new Error('invalid project model provider protocol')
  }
  if (row.baseURL !== null && (typeof row.baseURL !== 'string' || row.baseURL.length === 0)) {
    throw new Error('invalid project model provider base URL')
  }
  if (row.credentialRef !== null && (typeof row.credentialRef !== 'string' || row.credentialRef.length === 0)) {
    throw new Error('invalid project model provider credential reference')
  }
  const models = row.models === undefined ? undefined : (() => {
    if (!Array.isArray(row.models)) throw new Error('invalid project model provider models')
    return row.models.map((model) => {
      const item = object(model)
      return { id: nonEmptyText(item.id, 'model id'), name: nonEmptyText(item.name, 'model name') }
    })
  })()
  return {
    provider: nonEmptyText(row.provider, 'provider'),
    runtimeProvider: nonEmptyText(row.runtimeProvider, 'runtime provider'),
    displayName: nonEmptyText(row.displayName, 'display name'),
    protocol: row.protocol === null ? null : row.protocol,
    baseURL: row.baseURL === null ? null : row.baseURL,
    authMode,
    status,
    credentialRef: row.credentialRef === null ? null : row.credentialRef,
    credentialConfigured: row.credentialConfigured,
    revision: row.revision,
    modelCount: row.modelCount,
    ...(row.profile === undefined ? {} : { profile: object(row.profile) }),
    ...(models === undefined ? {} : { models }),
  }
}

function modelGroups(value: unknown): ProjectModelSettingsView['models'] {
  const root = object(value)
  if (!Array.isArray(root.groups) || !Array.isArray(root.failures)) throw new Error('invalid project model catalog')
  const groups = root.groups.map((groupValue) => {
    const group = object(groupValue)
    if (!Array.isArray(group.models)) throw new Error('invalid project model group')
    return {
      id: text(group.id, 'group id'),
      name: text(group.name, 'group name'),
      models: group.models.map((modelValue) => {
        const model = object(modelValue)
        const contextWindow = optionalPositiveInteger(model.contextWindow, 'context window')
        const maxTokens = optionalPositiveInteger(model.maxTokens, 'max tokens')
        const inputModalities = modalities(model.inputModalities, 'input modalities')
        return {
          id: nonEmptyText(model.id, 'model id'),
          name: nonEmptyText(model.name, 'model name'),
          ...contextWindow === undefined ? {} : { contextWindow },
          ...maxTokens === undefined ? {} : { maxTokens },
          ...inputModalities === undefined ? {} : { inputModalities },
        }
      }),
    }
  })
  const failures = root.failures.map((failureValue) => {
    const failure = object(failureValue)
    return {
      id: nonEmptyText(failure.id, 'failure id'),
      name: nonEmptyText(failure.name, 'failure name'),
      message: nonEmptyText(failure.message, 'failure message'),
    }
  })
  return { groups, failures }
}

/** Parse a project settings response at the browser trust boundary.
 * @param value - untrusted JSON response.
 * @returns the validated project model settings view.
 */
export function parseProjectModelSettings(value: unknown): ProjectModelSettingsView {
  const row = object(value)
  if (row.hasDocument !== false || typeof row.writable !== 'boolean' || !Array.isArray(row.namespaces)
    || !Array.isArray(row.providers) || typeof row.models !== 'object' || row.models === null || Array.isArray(row.models)
    || !Array.isArray((row.models as Record<string, unknown>).groups)
    || !Array.isArray((row.models as Record<string, unknown>).failures)) {
    throw new Error('invalid project model settings response')
  }
  return {
    projectId: positiveInteger(row.projectId, 'project id'),
    revision: integer(row.revision, 'revision'),
    writable: row.writable,
    hasDocument: false,
    namespaces: row.namespaces.map(namespace),
    providers: row.providers.map(providerView),
    models: modelGroups(row.models),
  }
}

function discoveredModels(value: unknown): DiscoveredModelView[] {
  if (!Array.isArray(value)) throw new Error('invalid project model discovery response')
  return value.map((modelValue) => {
    const model = object(modelValue)
    const contextWindow = optionalPositiveInteger(model.contextWindow, 'discovered context window')
    const maxTokens = optionalPositiveInteger(model.maxTokens, 'discovered max tokens')
    const inputModalities = modalities(model.inputModalities, 'discovered input modalities')
    return {
      id: nonEmptyText(model.id, 'discovered model id'),
      ...model.name === undefined ? {} : { name: nonEmptyText(model.name, 'discovered model name') },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...inputModalities === undefined ? {} : { inputModalities },
    }
  })
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const contentType = response.headers.get('content-type') ?? ''
  if (response.ok && !contentType.toLowerCase().includes('json')) {
    // A standalone Host may answer an unmounted account route with its SPA
    // shell. Treat that capability miss like the account transport does so the
    // project settings UI can explain the unavailable deployment.
    throw new ProjectModelSettingsRequestError(501, 'project-model-settings-unsupported')
  }
  let value: unknown
  try { value = await readApiResponseJson(response) } catch {
    throw new ProjectModelSettingsRequestError(response.status)
  }
  if (!response.ok) {
    const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    throw new ProjectModelSettingsRequestError(response.status, typeof row?.error === 'string' ? row.error : undefined)
  }
  return value
}

/** Create a same-origin Gateway transport for project-owned Providers.
 * @param fetcher - HTTP function used for same-origin requests.
 * @returns the project model settings transport.
 */
export function createBrowserProjectModelSettingsTransport(
  fetcher: typeof fetch = globalThis.fetch,
): ProjectModelSettingsTransport {
  const request = async (projectId: number, suffix: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetcher(`/account/api/projects/${String(projectId)}/model-settings${suffix}`, {
      credentials: 'same-origin', ...init,
    })
    return responseJson(response)
  }
  const jsonHeaders = { 'content-type': 'application/json' }
  return {
    get: async (projectId, signal) => parseProjectModelSettings(await request(projectId, '', withSignal(signal))),
    mutate: async (projectId, body, signal) => parseProjectModelSettings(await request(projectId, '', {
      method: 'PUT', ...withSignal(signal), headers: jsonHeaders, body: JSON.stringify(body),
    })),
    describeCredentials: async (projectId, refs, signal) => {
      const query = new URLSearchParams()
      for (const ref of refs) query.append('refs', ref)
      const value = object(await request(projectId, `/credentials?${query.toString()}`, withSignal(signal)))
      return { credentials: credentialViews(value.credentials) }
    },
    setCredential: (projectId, ref, value, signal) => request(projectId, '/credentials', {
      method: 'PUT', ...withSignal(signal), headers: jsonHeaders, body: JSON.stringify({ ref, value }),
    }).then(() => undefined),
    unsetCredential: (projectId, ref, signal) => request(projectId, '/credentials', {
      method: 'DELETE', ...withSignal(signal), headers: jsonHeaders, body: JSON.stringify({ ref }),
    }).then(() => undefined),
    discover: async (projectId, body, signal) => {
      const value = object(await request(projectId, '/discover', {
        method: 'POST', ...withSignal(signal), headers: jsonHeaders, body: JSON.stringify(body),
      }))
      return { models: discoveredModels(value.models) }
    },
  }
}
