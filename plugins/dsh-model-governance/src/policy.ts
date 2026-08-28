import { readFileSync } from 'node:fs'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  ManagedModelCompat,
  ManagedModelModality,
  ManagedModelProfile,
  ManagedModelProviderProfile,
  ManagedModelProviderProtocol,
  ManagedModelReasoningEfforts,
} from '@deepseek-ai/dsh-model-provider-config'

export interface GovernancePolicyFile {
  version: number
  defaultAllowed: boolean
  /**
   * Whether routes absent from `models` are authorized when the instance's own
   * settings user layer declares the provider (personal BYOK). The gateway
   * writes `true` for personal runtimes and `false` for shared project
   * runtimes; a route present in `models` always follows its catalog entry.
   */
  userDeclaredAllowed: boolean
  models: Array<{ provider: string; model: string; allowed: boolean }>
  providers: ManagedModelProviderProfile[]
  intakeUrl: string
  intakeToken: string
}

const ORGANIZATION_PROVIDER_PATTERN = /^org-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ORGANIZATION_CREDENTIAL_REF_PATTERN = /^DSH_[A-Z0-9_]+$/
const PROJECT_PROVIDER_PATTERN = /^project-[1-9][0-9]*-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PROJECT_CREDENTIAL_REF_PATTERN = /^DSH_PROJECT_[1-9][0-9]*_[A-Z0-9_]+$/
const PROTOCOLS = new Set<ManagedModelProviderProtocol>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])
const MODALITIES = new Set<ManagedModelModality>(['text', 'image'])
const REASONING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const CACHE_RETENTIONS = new Set(['none', 'short', 'long'])
const TRANSPORTS = new Set(['sse', 'websocket', 'websocket-cached', 'auto'])
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
/** Largest delay Node can schedule without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`model-governance: ${field} must be a non-empty string`)
  return value
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`model-governance: ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`model-governance: ${field} must be a positive safe integer`)
  }
  return value as number
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`model-governance: ${field} must be a non-negative safe integer`)
  }
  return value as number
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, field)
}

function optionalNonnegativeInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : nonnegativeInteger(value, field)
}

function optionalPositiveTimer(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`model-governance: ${field} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

function modalities(value: unknown, field: string): ManagedModelModality[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'string' || !MODALITIES.has(entry as ManagedModelModality))) {
    throw new Error(`model-governance: ${field} must contain text or image`)
  }
  return [...value] as ManagedModelModality[]
}

function reasoningEfforts(value: unknown, field: string): false | ManagedModelReasoningEfforts | undefined {
  if (value === undefined || value === false) return value
  const source = record(value, field)
  if (Object.keys(source).length === 0) {
    throw new Error(`model-governance: ${field} must contain at least one reasoning level`)
  }
  const result: Record<string, string | null> = {}
  for (const [level, spelling] of Object.entries(source)) {
    if (!REASONING_LEVELS.has(level) || (spelling !== null && typeof spelling !== 'string')) {
      throw new Error(`model-governance: ${field} contains an invalid reasoning level`)
    }
    if (spelling === '' || (spelling === null && level !== 'off')) {
      throw new Error(`model-governance: ${field}.${level} must contain a wire value; only off may be empty`)
    }
    result[level] = spelling
  }
  if (!Object.keys(result).some(level => level !== 'off')) {
    throw new Error(`model-governance: ${field} must offer a reasoning level beyond off`)
  }
  return result as ManagedModelReasoningEfforts
}

function compat(
  value: unknown,
  field: string,
  protocol: ManagedModelProviderProtocol,
): ManagedModelCompat | undefined {
  if (value === undefined) return undefined
  const source = record(value, field)
  const unsupported = Object.keys(source).find(key => !COMPAT_KEYS.has(key))
  if (unsupported !== undefined) {
    throw new Error(`model-governance: ${field} contains unsupported field ${unsupported}`)
  }
  if (source.thinkingFormat !== undefined && typeof source.thinkingFormat !== 'string') {
    throw new Error(`model-governance: ${field}.thinkingFormat must be a string`)
  }
  if (source.thinkingFormat !== undefined && !THINKING_FORMATS.has(source.thinkingFormat as string)) {
    throw new Error(`model-governance: ${field}.thinkingFormat is unsupported`)
  }
  if (source.supportsReasoningEffort !== undefined && typeof source.supportsReasoningEffort !== 'boolean') {
    throw new Error(`model-governance: ${field}.supportsReasoningEffort must be boolean`)
  }
  if (Object.keys(source).length > 0 && protocol !== 'openai-completions') {
    throw new Error(`model-governance: ${field} is supported only by openai-completions`)
  }
  return {
    ...source.thinkingFormat === undefined ? {} : { thinkingFormat: source.thinkingFormat },
    ...source.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: source.supportsReasoningEffort },
  }
}

function stringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const source = record(value, field)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry !== 'string') throw new Error(`model-governance: ${field}.${key} must be a string`)
    result[key] = entry
  }
  return result
}

function objectCopy(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return structuredClone(record(value, field))
}

/** Organization routes enumerate their models; only an empty schema default is valid here. */
function validateOrganizationModelOverrides(profile: Record<string, unknown>, field: string): void {
  if (profile.modelOverrides === undefined) return
  const overrides = record(profile.modelOverrides, `${field}.modelOverrides`)
  if (Object.keys(overrides).length > 0) {
    throw new Error(`model-governance: ${field}.modelOverrides is unsupported; declare fields in models`)
  }
}

function providerURL(value: unknown, field: string): string {
  const accepted = requiredString(value, field)
  let parsed: URL
  try {
    parsed = new URL(accepted)
  } catch {
    throw new Error(`model-governance: ${field} must be an absolute http or https URL`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new Error(`model-governance: ${field} must be an absolute http or https URL without credentials or a fragment`)
  }
  return accepted
}

function validateEmbeddedProfile(
  value: unknown,
  field: string,
  provider: string,
  protocol: ManagedModelProviderProtocol,
  baseURL: string,
  credentialRef: string | undefined,
  credentialPattern: RegExp,
): Record<string, unknown> | undefined {
  const profile = objectCopy(value, field)
  if (profile === undefined) return undefined
  if (profile.apiKeyEnv !== undefined) {
    const nestedRef = requiredString(profile.apiKeyEnv, `${field}.apiKeyEnv`)
    if (!credentialPattern.test(nestedRef)
      || credentialRef === undefined || nestedRef !== credentialRef) {
      throw new Error(`model-governance: ${field}.apiKeyEnv must match the Provider credentialRef`)
    }
  }
  if (profile.displayName !== undefined) requiredString(profile.displayName, `${field}.displayName`)
  if (profile.api !== undefined && requiredString(profile.api, `${field}.api`) !== protocol) {
    throw new Error(`model-governance: ${field}.api must match the Provider protocol`)
  }
  if (profile.baseURL !== undefined && providerURL(profile.baseURL, `${field}.baseURL`) !== baseURL) {
    throw new Error(`model-governance: ${field}.baseURL must match the Provider baseURL`)
  }
  if (profile.models !== undefined) {
    if (!Array.isArray(profile.models) || profile.models.length === 0) {
      throw new Error(`model-governance: ${field}.models must be a non-empty array`)
    }
    for (const [modelIndex, model] of profile.models.entries()) {
      const modelObject = record(model, `${field}.models/${String(modelIndex)}`)
      const id = requiredString(modelObject.id, `${field}.models/${String(modelIndex)}.id`)
      modelProfile({ ...modelObject, name: modelObject.name ?? id }, provider, modelIndex, protocol)
    }
  }
  validateOrganizationModelOverrides(profile, field)
  compat(profile.compat, `${field}.compat`, protocol)
  optionalPositiveInteger(profile.defaultContextWindow, `${field}.defaultContextWindow`)
  optionalPositiveInteger(profile.defaultMaxTokens, `${field}.defaultMaxTokens`)
  modalities(profile.defaultInput, `${field}.defaultInput`)
  stringMap(profile.headers, `${field}.headers`)
  if (profile.reasoning !== undefined) {
    const reasoning = requiredString(profile.reasoning, `${field}.reasoning`)
    if (!REASONING_LEVELS.has(reasoning)) throw new Error(`model-governance: ${field}.reasoning is invalid`)
  }
  if (profile.thinkingBudgets !== undefined) {
    const budgets = record(profile.thinkingBudgets, `${field}.thinkingBudgets`)
    for (const [level, budget] of Object.entries(budgets)) {
      if (!REASONING_LEVELS.has(level) || level === 'off' || level === 'xhigh' || level === 'max') {
        throw new Error(`model-governance: ${field}.thinkingBudgets contains an invalid level`)
      }
      positiveInteger(budget, `${field}.thinkingBudgets.${level}`)
    }
  }
  if (profile.cacheRetention !== undefined) {
    const retention = requiredString(profile.cacheRetention, `${field}.cacheRetention`)
    if (!CACHE_RETENTIONS.has(retention)) throw new Error(`model-governance: ${field}.cacheRetention is invalid`)
  }
  if (profile.transport !== undefined) {
    const transport = requiredString(profile.transport, `${field}.transport`)
    if (!TRANSPORTS.has(transport)) throw new Error(`model-governance: ${field}.transport is invalid`)
  }
  optionalNonnegativeInteger(profile.timeoutMs, `${field}.timeoutMs`)
  optionalNonnegativeInteger(profile.websocketConnectTimeoutMs, `${field}.websocketConnectTimeoutMs`)
  optionalPositiveTimer(profile.streamIdleTimeoutMs, `${field}.streamIdleTimeoutMs`)
  if (profile.retryPolicy !== undefined) {
    const retry = record(profile.retryPolicy, `${field}.retryPolicy`)
    resolveRetryPolicy(retry as unknown as Parameters<typeof resolveRetryPolicy>[0], `model-governance: ${field}.retryPolicy`)
  }
  return profile
}

function modelProfile(
  value: unknown,
  provider: string,
  modelIndex: number,
  protocol: ManagedModelProviderProtocol,
): ManagedModelProfile {
  const field = `providers/${provider}/models/${String(modelIndex)}`
  const source = record(value, field)
  const id = requiredString(source.id, `${field}.id`)
  const name = requiredString(source.name, `${field}.name`)
  const contextWindow = optionalPositiveInteger(source.contextWindow, `${field}.contextWindow`)
  const maxTokens = optionalPositiveInteger(source.maxTokens, `${field}.maxTokens`)
  const input = modalities(source.input, `${field}.input`)
  const efforts = reasoningEfforts(source.reasoningEfforts, `${field}.reasoningEfforts`)
  const modelCompat = compat(source.compat, `${field}.compat`, protocol)
  return {
    id,
    name,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...input === undefined ? {} : { input },
    ...efforts === undefined ? {} : { reasoningEfforts: efforts },
    ...modelCompat === undefined ? {} : { compat: modelCompat },
  }
}

function providerProfiles(value: unknown): ManagedModelProviderProfile[] {
  if (!Array.isArray(value)) throw new Error('model-governance: providers must be an array')
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`model-governance: providers[${String(index)}] must be an object`)
    }
    const row = entry as Record<string, unknown>
    const provider = requiredString(row.provider, `providers[${String(index)}].provider`)
    const declaredScope = row.scope
    if (declaredScope !== undefined && declaredScope !== 'organization' && declaredScope !== 'project') {
      throw new Error(`model-governance: providers[${String(index)}].scope is unsupported`)
    }
    // Policy files written before project routes existed had no scope field;
    // keep those entries on the organization path. A project route can still
    // be inferred from its deployment-owned prefix when an intermediate
    // writer omitted the optional metadata.
    const scope: 'organization' | 'project' = declaredScope === undefined
      ? provider.startsWith('project-') ? 'project' : 'organization'
      : declaredScope
    const providerPattern = scope === 'project' ? PROJECT_PROVIDER_PATTERN : ORGANIZATION_PROVIDER_PATTERN
    const credentialPattern = scope === 'project' ? PROJECT_CREDENTIAL_REF_PATTERN : ORGANIZATION_CREDENTIAL_REF_PATTERN
    if (!providerPattern.test(provider)) {
      throw new Error(
        `model-governance: providers[${String(index)}].provider must match ${String(providerPattern)}`,
      )
    }
    const projectId = row.projectId
    if (scope === 'project') {
      if (!Number.isSafeInteger(projectId) || Number(projectId) <= 0) {
        throw new Error(`model-governance: providers[${String(index)}].projectId must be a positive safe integer`)
      }
      if (!provider.startsWith(`project-${String(projectId)}-`)) {
        throw new Error(`model-governance: providers[${String(index)}].provider does not belong to project ${String(projectId)}`)
      }
    } else if (projectId !== undefined) {
      throw new Error(`model-governance: organization Provider cannot carry projectId`)
    }
    if (seen.has(provider)) throw new Error(`model-governance: duplicate Provider ${provider}`)
    seen.add(provider)
    if (row.driver !== 'pi-ai') throw new Error(`model-governance: providers[${String(index)}].driver must be pi-ai`)
    if (typeof row.protocol !== 'string' || !PROTOCOLS.has(row.protocol as ManagedModelProviderProtocol)) {
      throw new Error(`model-governance: providers[${String(index)}].protocol is unsupported`)
    }
    const protocol = row.protocol as ManagedModelProviderProtocol
    const credentialRef = row.credentialRef
    if (credentialRef !== undefined
      && (typeof credentialRef !== 'string' || !credentialPattern.test(credentialRef))) {
      throw new Error(`model-governance: providers[${String(index)}].credentialRef must be a scoped credential reference`)
    }
    if (scope === 'project' && credentialRef !== undefined
      && !credentialRef.startsWith(`DSH_PROJECT_${String(projectId)}_`)) {
      throw new Error(`model-governance: providers[${String(index)}].credentialRef does not belong to project ${String(projectId)}`)
    }
    if (scope === 'organization' && credentialRef?.startsWith('DSH_PROJECT_')) {
      throw new Error(`model-governance: providers[${String(index)}].credentialRef must not use a project credential reference`)
    }
    if (!Array.isArray(row.models) || row.models.length === 0) {
      throw new Error(`model-governance: providers[${String(index)}].models must be a non-empty array`)
    }
    const modelIds = new Set<string>()
    const models = row.models.map((model, modelIndex) => {
      const normalized = modelProfile(model, provider, modelIndex, protocol)
      if (modelIds.has(normalized.id)) throw new Error(`model-governance: duplicate model ${provider}/${normalized.id}`)
      modelIds.add(normalized.id)
      return normalized
    })
    const displayName = requiredString(row.displayName, `providers[${String(index)}].displayName`)
    const baseURL = providerURL(row.baseURL, `providers[${String(index)}].baseURL`)
    const profile = validateEmbeddedProfile(
      row.profile,
      `providers/${String(index)}.profile`,
      provider,
      protocol,
      baseURL,
      credentialRef,
      credentialPattern,
    )
    const defaultContextWindow = optionalPositiveInteger(row.defaultContextWindow, `providers/${String(index)}.defaultContextWindow`)
    const defaultMaxTokens = optionalPositiveInteger(row.defaultMaxTokens, `providers/${String(index)}.defaultMaxTokens`)
    const defaultInput = modalities(row.defaultInput, `providers/${String(index)}.defaultInput`)
    const headers = stringMap(row.headers, `providers/${String(index)}.headers`)
    const reasoning = row.reasoning === undefined ? undefined : requiredString(row.reasoning, `providers/${String(index)}.reasoning`)
    if (reasoning !== undefined && !REASONING_LEVELS.has(reasoning)) {
      throw new Error(`model-governance: providers/${String(index)}.reasoning is invalid`)
    }
    const thinkingBudgets = row.thinkingBudgets === undefined ? undefined : (() => {
      const source = record(row.thinkingBudgets, `providers/${String(index)}.thinkingBudgets`)
      const result: Record<string, number> = {}
      for (const [level, budget] of Object.entries(source)) {
        if (!REASONING_LEVELS.has(level) || level === 'off' || level === 'xhigh' || level === 'max') {
          throw new Error(`model-governance: providers/${String(index)}.thinkingBudgets contains an invalid level`)
        }
        result[level] = positiveInteger(budget, `providers/${String(index)}.thinkingBudgets.${level}`)
      }
      return result as ManagedModelProviderProfile['thinkingBudgets']
    })()
    const cacheRetention = row.cacheRetention === undefined ? undefined : requiredString(row.cacheRetention, `providers/${String(index)}.cacheRetention`)
    if (cacheRetention !== undefined && !CACHE_RETENTIONS.has(cacheRetention)) {
      throw new Error(`model-governance: providers/${String(index)}.cacheRetention is invalid`)
    }
    const transport = row.transport === undefined ? undefined : requiredString(row.transport, `providers/${String(index)}.transport`)
    if (transport !== undefined && !TRANSPORTS.has(transport)) {
      throw new Error(`model-governance: providers/${String(index)}.transport is invalid`)
    }
    const timeoutMs = optionalNonnegativeInteger(row.timeoutMs, `providers/${String(index)}.timeoutMs`)
    const websocketConnectTimeoutMs = optionalNonnegativeInteger(row.websocketConnectTimeoutMs, `providers/${String(index)}.websocketConnectTimeoutMs`)
    const streamIdleTimeoutMs = optionalPositiveTimer(row.streamIdleTimeoutMs, `providers/${String(index)}.streamIdleTimeoutMs`)
    const retryPolicy = row.retryPolicy === undefined ? undefined : (() => {
      const source = record(row.retryPolicy, `providers/${String(index)}.retryPolicy`)
      const path = `model-governance: providers/${String(index)}.retryPolicy`
      resolveRetryPolicy(source as unknown as Parameters<typeof resolveRetryPolicy>[0], path)
      return structuredClone(source)
    })()
    return {
      provider,
      displayName,
      driver: 'pi-ai',
      protocol,
      baseURL,
      ...scope === 'project' ? { scope: 'project' as const, projectId: projectId as number } : {},
      ...credentialRef === undefined ? {} : { credentialRef },
      ...profile === undefined ? {} : { profile },
      ...defaultContextWindow === undefined ? {} : { defaultContextWindow },
      ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
      ...defaultInput === undefined ? {} : { defaultInput },
      ...headers === undefined ? {} : { headers },
      ...reasoning === undefined ? {} : { reasoning: reasoning as ManagedModelProviderProfile['reasoning'] },
      ...thinkingBudgets === undefined ? {} : { thinkingBudgets },
      ...cacheRetention === undefined ? {} : { cacheRetention: cacheRetention as ManagedModelProviderProfile['cacheRetention'] },
      ...transport === undefined ? {} : { transport: transport as ManagedModelProviderProfile['transport'] },
      ...timeoutMs === undefined ? {} : { timeoutMs },
      ...websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs },
      ...streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs },
      ...retryPolicy === undefined ? {} : { retryPolicy: retryPolicy as ManagedModelProviderProfile['retryPolicy'] },
      models,
    }
  })
}

/** Load and fail closed on a missing or malformed deployment policy. */
export function loadPolicy(filename: string): GovernancePolicyFile {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(filename, 'utf8')) } catch (error) {
    throw new Error(`model-governance: cannot load policy ${filename}: ${String(error)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('model-governance: policy must be an object')
  const input = raw as Record<string, unknown>
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 0) throw new Error('model-governance: version must be a non-negative integer')
  if (typeof input.defaultAllowed !== 'boolean' || !Array.isArray(input.models)) throw new Error('model-governance: invalid policy defaults')
  if (typeof input.userDeclaredAllowed !== 'boolean') throw new Error('model-governance: userDeclaredAllowed must be boolean')
  const seen = new Set<string>()
  const models = input.models.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`model-governance: models[${index}] must be an object`)
    const row = entry as Record<string, unknown>
    const provider = requiredString(row.provider, `models[${index}].provider`)
    const model = requiredString(row.model, `models[${index}].model`)
    if (typeof row.allowed !== 'boolean') throw new Error(`model-governance: models[${index}].allowed must be boolean`)
    const key = `${provider}\0${model}`
    if (seen.has(key)) throw new Error(`model-governance: duplicate route ${provider}/${model}`)
    seen.add(key)
    return { provider, model, allowed: row.allowed }
  })
  return {
    version: Number(input.version), defaultAllowed: input.defaultAllowed,
    userDeclaredAllowed: input.userDeclaredAllowed, models, providers: providerProfiles(input.providers),
    intakeUrl: requiredString(input.intakeUrl, 'intakeUrl'), intakeToken: requiredString(input.intakeToken, 'intakeToken'),
  }
}
