/** Validated, bounded private control messages for one managed SDK child. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Per-child monotonically registered opaque operation identity. */
export type SdkControlId = Branded<'SdkControlId'>

/** Deployment limits shared by both ends of one private child control connection. */
export interface SdkControlConfig {
  /** Maximum serialized request or response bytes. */
  maxBytes: number
  /** Maximum simultaneously retained model spans and resource operations. */
  maxOperations: number
  /** Maximum duration of one control exchange, including its body. */
  requestTimeoutMs: number
  /** Maximum server-side wait before a polling response. */
  pollMs: number
  /** Maximum joined shutdown time for control operations. */
  cleanupTimeoutMs: number
}

/** Control connection passed only through the explicit SDK child environment. */
export interface SdkControlConnection { url: string; token: string; config: SdkControlConfig }

/** Private environment name removed by the subprocess seam's DSH credential scrub. */
export const SDK_PARENT_CONTROL_ENV = 'DSH_SDK_PARENT_CONTROL'

/**
 * Read a control envelope as a JSON object, rejecting arrays and null.
 * @param value - decoded JSON value.
 * @returns the envelope fields.
 */
export function controlRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid SDK control object.')
  return value as Record<string, unknown>
}

/**
 * Parse a positive safe sequence number encoded as a string.
 * @param value - operation id from the private wire.
 * @returns a validated opaque id.
 */
export function controlId(value: unknown): SdkControlId {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError('Invalid SDK control operation id.')
  }
  return value as SdkControlId
}

/**
 * Validate the loopback address, bearer token and shared size and timing limits.
 * @param value - bounded connection document from the child's explicit environment.
 * @returns validated connection settings.
 */
export function controlConnection(value: unknown): SdkControlConnection {
  const row = controlRecord(value), config = controlRecord(row.config)
  if (typeof row.token !== 'string' || row.token.length < 32 || typeof row.url !== 'string') throw new TypeError('Invalid SDK control connection.')
  const url = new URL(row.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new TypeError('Invalid SDK control endpoint.')
  for (const key of ['maxBytes', 'maxOperations', 'requestTimeoutMs', 'pollMs', 'cleanupTimeoutMs']) {
    if (typeof config[key] !== 'number' || !Number.isSafeInteger(config[key]) || config[key] < 1) throw new TypeError('Invalid SDK control limit.')
  }
  if (Number(config.pollMs) >= Number(config.requestTimeoutMs)
    || Number(config.requestTimeoutMs) >= Number(config.cleanupTimeoutMs)
    || Number(config.cleanupTimeoutMs) > 2_147_483_647) throw new TypeError('Invalid SDK control timing.')
  return { url: row.url, token: row.token, config: {
    ...config,
    maxBytes: Number(config.maxBytes), maxOperations: Number(config.maxOperations),
    requestTimeoutMs: Number(config.requestTimeoutMs), pollMs: Number(config.pollMs), cleanupTimeoutMs: Number(config.cleanupTimeoutMs),
  } }
}

/**
 * Read bounded UTF-8 JSON without retaining chunks that exceed the byte limit.
 * @param parts - byte stream from one control message.
 * @param maxBytes - accepted byte limit.
 * @returns decoded JSON, rejecting non-finite numbers.
 */
export async function controlJson(parts: AsyncIterable<Uint8Array>, maxBytes: number): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of parts) {
    size += chunk.byteLength
    if (size > maxBytes) throw new ResourceAdmissionError('refused', 'SDK control message exceeds its byte limit.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'), (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Invalid SDK JSON number.')
    return value
  })
}

/**
 * Validate model request fields and exclude child-supplied parent authority.
 * @param value - request metadata crossing the child process wire.
 * @returns validated request fields without parent authority.
 */
export function controlOptions(value: unknown): GenerateOptions {
  const row = controlRecord(value)
  if (typeof row.provider !== 'string' || row.provider === '' || typeof row.model !== 'string' || row.model === ''
    || !Array.isArray(row.messages)) throw new TypeError('Invalid SDK model request.')
  for (const value of row.messages) {
    const message = controlRecord(value)
    if (!['user', 'assistant', 'system', 'developer', 'tool'].includes(String(message.role)) || !Array.isArray(message.content)) {
      throw new TypeError('Invalid SDK model message.')
    }
    for (const value of message.content) {
      const block = controlRecord(value)
      if (typeof block.type !== 'string' || block.type === '') throw new TypeError('Invalid SDK model content.')
      if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text !== 'string') throw new TypeError('Invalid SDK text content.')
    }
  }
  if (row.system !== undefined && typeof row.system !== 'string') throw new TypeError('Invalid SDK model system text.')
  if (row.reasoningEffort !== undefined && (typeof row.reasoningEffort !== 'string' || row.reasoningEffort === '')) {
    throw new TypeError('Invalid SDK reasoning effort.')
  }
  if (row.purpose !== undefined && (typeof row.purpose !== 'string'
    || !['compaction', 'session-title', 'auto-review', 'memory', 'session-handoff', 'web-search', 'translation'].includes(row.purpose))) {
    throw new TypeError('Invalid SDK model purpose.')
  }
  if (row.tools !== undefined) {
    if (!Array.isArray(row.tools)) throw new TypeError('Invalid SDK model tools.')
    for (const value of row.tools) {
      const tool = controlRecord(value)
      if (typeof tool.name !== 'string' || typeof tool.description !== 'string'
        || tool.deferLoading !== undefined && tool.deferLoading !== true) throw new TypeError('Invalid SDK model tool.')
      controlRecord(tool.parameters)
    }
  }
  if (row.maxTokens !== undefined && (typeof row.maxTokens !== 'number' || !Number.isSafeInteger(row.maxTokens) || row.maxTokens < 1)) {
    throw new TypeError('Invalid SDK output limit.')
  }
  if (row.temperature !== undefined && (typeof row.temperature !== 'number' || !Number.isFinite(row.temperature))) {
    throw new TypeError('Invalid SDK temperature.')
  }
  if (row.stop !== undefined && (!Array.isArray(row.stop) || row.stop.some(value => typeof value !== 'string'))) {
    throw new TypeError('Invalid SDK stop sequences.')
  }
  if (row.operation !== undefined) {
    const operation = controlRecord(row.operation)
    if (typeof operation.name !== 'string' || operation.name === '' || operation.request === undefined) throw new TypeError('Invalid SDK model operation.')
  }
  const copy = { ...row }
  delete copy.signal
  delete copy.executionIdentity
  delete copy.resourceOrigin
  delete copy.sessionId
  // The parent observes inputs but never dispatches this wire object through an adapter.
  return { ...copy, provider: row.provider, model: row.model, messages: row.messages as RequestMessage[] }
}

/**
 * Validate one model chunk before relaying it through parent middleware.
 * @param value - one relayed adapter chunk.
 * @returns the validated stream envelope consumed by parent middleware.
 */
export function controlChunk(value: unknown): StreamChunk {
  const row = controlRecord(value)
  switch (row.type) {
    case 'usage': {
      const usage = controlRecord(row.usage)
      for (const key of ['inputTokens', 'outputTokens']) {
        if (typeof usage[key] !== 'number' || !Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new TypeError('Invalid SDK token usage.')
      }
      for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
        if (usage[key] !== undefined && (typeof usage[key] !== 'number' || !Number.isSafeInteger(usage[key]) || usage[key] < 0)) {
          throw new TypeError('Invalid SDK token usage.')
        }
      }
      if (row.credentialSource !== undefined && typeof row.credentialSource !== 'string') throw new TypeError('Invalid SDK credential source.')
      break
    }
    case 'finish': {
      const reason = controlRecord(row.reason)
      if (typeof reason.kind !== 'string' || reason.kind === '') throw new TypeError('Invalid SDK model outcome.')
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const failure = controlRecord(reason.failure)
        if (typeof failure.code !== 'string' || typeof failure.message !== 'string') throw new TypeError('Invalid SDK model failure.')
      }
      break
    }
    case 'text-delta': case 'reasoning-delta':
      if (typeof row.text !== 'string') throw new TypeError('Invalid SDK model text.')
      break
    case 'tool-call-delta':
      if (typeof row.id !== 'string' || typeof row.argumentsDelta !== 'string'
        || row.name !== undefined && typeof row.name !== 'string') throw new TypeError('Invalid SDK tool delta.')
      break
    case 'block-start':
      if (typeof row.blockType !== 'string') throw new TypeError('Invalid SDK block start.')
      break
    case 'block-end':
      if (typeof controlRecord(row.block).type !== 'string') throw new TypeError('Invalid SDK block end.')
      break
    default: throw new TypeError('Unknown SDK stream chunk.')
  }
  if (row.type !== 'usage' && row.type !== 'finish'
    && (typeof row.index !== 'number' || !Number.isSafeInteger(row.index) || row.index < 0)) throw new TypeError('Invalid SDK block index.')
  return row as StreamChunk
}
