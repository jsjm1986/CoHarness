import { ORGANIZATION_PROVIDER_PATTERN, type ModelProviderProtocol } from './model-governance.ts'
import { ORGANIZATION_MODEL_SETTINGS_SCHEMA } from './organization-model-settings-schema.ts'

/** Protocols accepted by the organization pi-ai profile. */
export const ORGANIZATION_PROVIDER_PROTOCOLS: readonly ModelProviderProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

const PROTOCOL_SET = new Set<string>(ORGANIZATION_PROVIDER_PROTOCOLS)
/** Credential references owned by organization-managed Provider profiles. */
export const ORGANIZATION_CREDENTIAL_REF_PATTERN = /^DSH_[A-Z0-9_]+$/
const REASONING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const THINKING_BUDGET_LEVELS = new Set(['minimal', 'low', 'medium', 'high'])
const THINKING_FORMATS = new Set([
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'zai',
  'qwen',
  'string-thinking',
  'ant-ling',
])
const COMPAT_KEYS = new Set(['thinkingFormat', 'supportsReasoningEffort'])
const CACHE_RETENTION = new Set(['none', 'short', 'long'])
const TRANSPORTS = new Set(['sse', 'websocket', 'websocket-cached', 'auto'])
const NORMAL_RETRY_KEYS = new Set(['mode', 'maxRetries', 'retryableCodes', 'backoff'])
const ALWAYS_RETRY_KEYS = new Set(['mode', 'backoff'])
const RETRY_BACKOFF_KEYS = new Set(['initialDelayMs', 'maxDelayMs', 'jitterRatio'])
const DEFAULT_INITIAL_RETRY_DELAY_MS = 500
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000
/** Largest delay Node can schedule without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Clone JSON-compatible data without retaining a caller-owned reference. */
export function cloneOrganizationJson<T>(value: T): T {
  return structuredClone(value)
}

/** Require a JSON object and retain a useful path in the diagnostic. */
export function organizationObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive safe integer`)
  }
}

function nonnegativeInteger(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`)
  }
}

function positiveTimer(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path} must be a positive finite number no greater than ${String(MAX_TIMER_DELAY_MS)}`)
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, accepted: ReadonlySet<string>, path: string): void {
  const key = Object.keys(value).find(candidate => !accepted.has(candidate))
  if (key !== undefined) throw new Error(`${path} contains unsupported field ${key}`)
}

function optionalString(profile: Record<string, unknown>, key: string, path: string): void {
  const value = profile[key]
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`${path}.${key} must be a non-empty string`)
  }
}

function validateCompat(value: unknown, path: string, protocol: ModelProviderProtocol): void {
  const compat = organizationObject(value, path)
  rejectUnknownKeys(compat, COMPAT_KEYS, path)
  if (compat.thinkingFormat !== undefined) {
    if (typeof compat.thinkingFormat !== 'string' || !THINKING_FORMATS.has(compat.thinkingFormat)) {
      throw new Error(`${path}.thinkingFormat is unsupported`)
    }
  }
  if (compat.supportsReasoningEffort !== undefined && typeof compat.supportsReasoningEffort !== 'boolean') {
    throw new Error(`${path}.supportsReasoningEffort must be boolean`)
  }
  if (Object.keys(compat).length > 0 && protocol !== 'openai-completions') {
    throw new Error(`${path} is supported only by openai-completions`)
  }
}

function validateReasoningEfforts(value: unknown, path: string): void {
  if (value === false) return
  const efforts = organizationObject(value, path)
  if (Object.keys(efforts).length === 0) {
    throw new Error(`${path} must contain at least one reasoning level`)
  }
  let thinkingLevel = false
  for (const [level, spelling] of Object.entries(efforts)) {
    if (!REASONING_LEVELS.has(level) || (spelling !== null && typeof spelling !== 'string')) {
      throw new Error(`${path} contains an invalid reasoning level`)
    }
    if (spelling === '' || (spelling === null && level !== 'off')) {
      throw new Error(`${path}.${level} must contain a wire value; only off may be empty`)
    }
    if (level !== 'off') thinkingLevel = true
  }
  if (!thinkingLevel) throw new Error(`${path} must offer a reasoning level beyond off`)
}

function validateRetryBackoff(value: unknown, path: string): void {
  if (value === undefined) return
  const backoff = organizationObject(value, path)
  rejectUnknownKeys(backoff, RETRY_BACKOFF_KEYS, path)
  const initialDelayMs = backoff.initialDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS
  const maxDelayMs = backoff.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
  positiveTimer(initialDelayMs, `${path}.initialDelayMs`)
  positiveTimer(maxDelayMs, `${path}.maxDelayMs`)
  if ((initialDelayMs as number) > (maxDelayMs as number)) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  const jitterRatio = backoff.jitterRatio
  if (jitterRatio !== undefined
    && (typeof jitterRatio !== 'number' || !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1)) {
    throw new Error(`${path}.jitterRatio must be between 0 and 1`)
  }
}

function validateRetryPolicy(value: unknown, path: string): void {
  const policy = organizationObject(value, path)
  switch (policy.mode) {
    case 'normal': {
      rejectUnknownKeys(policy, NORMAL_RETRY_KEYS, path)
      if (policy.maxRetries !== undefined) nonnegativeInteger(policy.maxRetries, `${path}.maxRetries`)
      if (policy.retryableCodes !== undefined) {
        if (!Array.isArray(policy.retryableCodes) || policy.retryableCodes.length === 0
          || policy.retryableCodes.some(code => typeof code !== 'string' || code.length === 0)) {
          throw new Error(`${path}.retryableCodes must contain non-empty strings`)
        }
        if (new Set(policy.retryableCodes).size !== policy.retryableCodes.length) {
          throw new Error(`${path}.retryableCodes must not contain duplicates`)
        }
      }
      validateRetryBackoff(policy.backoff, `${path}.backoff`)
      return
    }
    case 'always':
      rejectUnknownKeys(policy, ALWAYS_RETRY_KEYS, path)
      validateRetryBackoff(policy.backoff, `${path}.backoff`)
      return
    default:
      throw new Error(`${path}.mode must be normal or always`)
  }
}

function validateModel(
  model: unknown,
  index: number,
  provider: string,
  protocol: ModelProviderProtocol,
): Record<string, unknown> {
  const path = `provider ${provider} model ${String(index + 1)}`
  const row = organizationObject(model, path)
  if (typeof row.id !== 'string' || row.id.trim() === '') throw new Error(`${path}.id must be a non-empty string`)
  if (row.name !== undefined && (typeof row.name !== 'string' || row.name.trim() === '')) {
    throw new Error(`${path}.name must be a non-empty string`)
  }
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    if (row[key] !== undefined) positiveInteger(row[key], `${path}.${key}`)
  }
  if (row.input !== undefined) {
    if (!Array.isArray(row.input) || row.input.length === 0 || row.input.some(value => value !== 'text' && value !== 'image')) {
      throw new Error(`${path}.input must contain text or image`)
    }
  }
  if (row.reasoningEfforts !== undefined) validateReasoningEfforts(row.reasoningEfforts, `${path}.reasoningEfforts`)
  if (row.compat !== undefined) validateCompat(row.compat, `${path}.compat`, protocol)
  return cloneOrganizationJson(row)
}

/** Reject catalog-only overrides on organization routes, which always declare their models explicitly. */
function validateModelOverrides(profile: Record<string, unknown>, provider: string): void {
  if (profile.modelOverrides === undefined) return
  const overrides = organizationObject(profile.modelOverrides, `provider ${provider}.modelOverrides`)
  if (Object.keys(overrides).length > 0) {
    throw new Error(`provider ${provider}.modelOverrides is unsupported; declare organization model fields in models`)
  }
}

function validateProfile(provider: string, raw: unknown): Record<string, unknown> {
  if (!ORGANIZATION_PROVIDER_PATTERN.test(provider)) {
    throw new Error(`organization provider must match ${String(ORGANIZATION_PROVIDER_PATTERN)}`)
  }
  const profile = organizationObject(raw, `provider ${provider}`)
  optionalString(profile, 'apiKeyEnv', `provider ${provider}`)
  if (profile.apiKeyEnv !== undefined
    && !ORGANIZATION_CREDENTIAL_REF_PATTERN.test(profile.apiKeyEnv as string)) {
    throw new Error(`provider ${provider}.apiKeyEnv must use an organization credential reference beginning with DSH_`)
  }
  optionalString(profile, 'displayName', `provider ${provider}`)
  if (typeof profile.api !== 'string' || !PROTOCOL_SET.has(profile.api)) {
    throw new Error(`provider ${provider}.api must be a supported protocol`)
  }
  if (typeof profile.baseURL !== 'string' || profile.baseURL.trim() === '') {
    throw new Error(`provider ${provider}.baseURL must be an absolute http or https URL`)
  }
  let url: URL
  try {
    url = new URL(profile.baseURL)
  } catch {
    throw new Error(`provider ${provider}.baseURL must be an absolute http or https URL`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error(`provider ${provider}.baseURL must be an absolute http or https URL without credentials or a fragment`)
  }
  const protocol = profile.api as ModelProviderProtocol
  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    throw new Error(`provider ${provider}.models must contain at least one model`)
  }
  const models = profile.models.map((model, index) => validateModel(model, index, provider, protocol))
  validateModelOverrides(profile, provider)
  const ids = new Set<string>()
  for (const model of models) {
    const id = model.id as string
    if (ids.has(id)) throw new Error(`provider ${provider} has duplicate model id ${id}`)
    ids.add(id)
  }
  for (const key of ['defaultContextWindow', 'defaultMaxTokens'] as const) {
    if (profile[key] !== undefined) positiveInteger(profile[key], `provider ${provider}.${key}`)
  }
  if (profile.defaultInput !== undefined) {
    if (!Array.isArray(profile.defaultInput) || profile.defaultInput.length === 0
      || profile.defaultInput.some(value => value !== 'text' && value !== 'image')) {
      throw new Error(`provider ${provider}.defaultInput must contain text or image`)
    }
  }
  if (profile.compat !== undefined) validateCompat(profile.compat, `provider ${provider}.compat`, protocol)
  if (profile.headers !== undefined) {
    const headers = organizationObject(profile.headers, `provider ${provider}.headers`)
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') throw new Error(`provider ${provider}.headers.${key} must be a string`)
    }
  }
  if (profile.reasoning !== undefined && (typeof profile.reasoning !== 'string' || !REASONING_LEVELS.has(profile.reasoning))) {
    throw new Error(`provider ${provider}.reasoning is invalid`)
  }
  if (profile.thinkingBudgets !== undefined) {
    const budgets = organizationObject(profile.thinkingBudgets, `provider ${provider}.thinkingBudgets`)
    for (const [level, budget] of Object.entries(budgets)) {
      if (!THINKING_BUDGET_LEVELS.has(level)) {
        throw new Error(`provider ${provider}.thinkingBudgets contains an invalid level`)
      }
      positiveInteger(budget, `provider ${provider}.thinkingBudgets.${level}`)
    }
  }
  if (profile.cacheRetention !== undefined && (typeof profile.cacheRetention !== 'string' || !CACHE_RETENTION.has(profile.cacheRetention))) {
    throw new Error(`provider ${provider}.cacheRetention is invalid`)
  }
  if (profile.transport !== undefined && (typeof profile.transport !== 'string' || !TRANSPORTS.has(profile.transport))) {
    throw new Error(`provider ${provider}.transport is invalid`)
  }
  for (const key of ['timeoutMs', 'websocketConnectTimeoutMs'] as const) {
    if (profile[key] !== undefined) nonnegativeInteger(profile[key], `provider ${provider}.${key}`)
  }
  if (profile.streamIdleTimeoutMs !== undefined) {
    positiveTimer(profile.streamIdleTimeoutMs, `provider ${provider}.streamIdleTimeoutMs`)
  }
  if (profile.retryPolicy !== undefined) validateRetryPolicy(profile.retryPolicy, `provider ${provider}.retryPolicy`)
  return { ...cloneOrganizationJson(profile), models }
}

/** Validate and clone the provider dictionary stored by the organization facade. */
export function validateOrganizationProfiles(value: unknown): Record<string, Record<string, unknown>> {
  const section = organizationObject(value, 'organization model settings')
  const providers = organizationObject(section.providers, 'organization model settings.providers')
  return Object.fromEntries(Object.entries(providers).map(([provider, profile]) => [provider, validateProfile(provider, profile)]))
}

interface SerializedSchemaNode {
  dict?: Record<string, number>
}

interface SerializedSettingsSchema {
  refs?: Record<string, SerializedSchemaNode>
}

/** The serialized schema consumed by the shared ModelsSection. */
export function organizationModelSettingsSchema(): unknown {
  const schema = cloneOrganizationJson(ORGANIZATION_MODEL_SETTINGS_SCHEMA) as SerializedSettingsSchema
  // Organization routes enumerate models explicitly; modelOverrides belongs to
  // installed catalog routes and must not be offered by the organization editor.
  for (const node of Object.values(schema.refs ?? {})) {
    if (node.dict !== undefined) delete node.dict.modelOverrides
  }
  return schema
}

interface ListingEntry {
  id?: unknown
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
}

function listingString(...values: readonly unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.length > 0) as string | undefined
}

function listingCapacity(...values: readonly unknown[]): number | undefined {
  return values.find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) as number | undefined
}

async function boundedBody(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error(`${url} answered with more than ${String(MAX_RESPONSE_BYTES)} bytes`)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error(`${url} answered with more than ${String(MAX_RESPONSE_BYTES)} bytes`)
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(data)
}

/** Discover models through the OpenAI-compatible listing endpoint. */
export async function discoverOrganizationModels(request: {
  baseURL?: string
  api?: string
  apiKey?: string
}): Promise<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>> {
  if (request.baseURL === undefined || request.baseURL.trim() === '') throw new Error('set a baseURL before discovering models')
  const api = request.api ?? 'openai-completions'
  if (api !== 'openai-completions' && api !== 'openai-responses') {
    throw new Error(`protocol ${api} has no model listing this build can read; enter models by hand`)
  }
  const base = request.baseURL.replace(/\/+$/, '')
  const url = `${base}/models`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('baseURL must be an absolute http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('baseURL must use http or https')
  const key = request.apiKey?.trim()
  if (request.apiKey !== undefined && key === '') throw new Error('API key is blank')
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      },
    })
  } catch (error) {
    throw new Error(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`)
  let body: unknown
  try {
    body = JSON.parse(await boundedBody(response, url))
  } catch (error) {
    throw new Error(error instanceof Error && error.message.includes('more than') ? error.message : `${url} did not answer with JSON`)
  }
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new Error('the endpoint model listing has no data array; enter models by hand')
  const models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }> = []
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = listingString(entry?.id)
    if (id === undefined) continue
    const name = listingString(entry?.name, entry?.display_name)
    const contextWindow = listingCapacity(entry?.context_window, entry?.context_length)
    const maxTokens = listingCapacity(entry?.max_output_tokens, entry?.max_tokens)
    models.push({ id, ...name === undefined ? {} : { name }, ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens } })
  }
  return models
}
