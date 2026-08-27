/**
 * Provider-neutral HTTP model discovery for OpenAI-compatible and Anthropic
 * Messages endpoints. Configuration surfaces delegate the wire request,
 * response limit, and listing parser here so they do not drift by entrypoint.
 *
 * @module @deepseek-ai/dsh-llm/discovery
 */

import { attributionHeaders } from './attribution.ts'
import { normalizeApiKey } from './api-key.ts'
import { INVALID_CREDENTIAL_CODE, LlmError } from './error.ts'
import type { LlmDiscoveredModel } from './types.ts'

/** Protocols whose documented `GET /models` response this helper can read. */
export const MODEL_LISTING_PROTOCOLS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
] as const

/** One protocol with a model-listing endpoint owned by this helper. */
export type ModelListingProtocol = (typeof MODEL_LISTING_PROTOCOLS)[number]

/** Maximum response bytes accepted from a caller-supplied model-listing URL. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** One endpoint interrogation; unlike the settings-level request, `baseURL` is required. */
export interface LlmEndpointModelDiscoveryRequest {
  /** Absolute HTTP(S) endpoint prefix to interrogate. */
  baseURL: string
  /** Wire protocol spoken by the endpoint; omitted means OpenAI Chat Completions. */
  api?: string
  /** One-shot credential; it is never stored by this helper. */
  apiKey?: string
  /** Caller cancellation signal. */
  signal?: AbortSignal
}

/**
 * Check whether this build owns a model-listing request for one protocol.
 *
 * @param api - protocol identifier from a provider draft.
 * @returns `true` when the identifier is a supported model-listing protocol.
 */
export function supportsModelListing(api: string): api is ModelListingProtocol {
  return (MODEL_LISTING_PROTOCOLS as readonly string[]).includes(api)
}

/** One entry of an OpenAI-compatible or Anthropic-compatible listing reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
}

/** A positive safe integer field of a listing entry, or `undefined`. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Build the listing URL while retaining deployment path segments. Anthropic
 * endpoints conventionally use `/v1/models`; when the caller already supplied
 * a `/v1` prefix, do not produce the invalid `/v1/v1/models` variant.
 */
function listingUrl(rawBaseURL: string, api: ModelListingProtocol): string {
  const baseURL = rawBaseURL.trim()
  let base: URL
  try {
    base = new URL(baseURL)
  } catch (error: unknown) {
    throw new LlmError('baseURL must be an absolute http or https URL', 'DISCOVERY_FAILED', { cause: error })
  }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:')
    || base.username !== '' || base.password !== '' || base.hash !== '') {
    throw new LlmError('baseURL must be an absolute http or https URL without credentials or a fragment', 'DISCOVERY_FAILED')
  }
  const path = base.pathname.replace(/\/+$/, '')
  const anthropicV1 = api === 'anthropic-messages' && !path.endsWith('/v1')
  base.pathname = `${path}${anthropicV1 ? '/v1' : ''}/models`
  return base.toString()
}

/** Build protocol-specific authentication and version headers. */
function listingHeaders(api: ModelListingProtocol, apiKey: string | undefined): Record<string, string> {
  if (api === 'anthropic-messages') {
    return {
      'anthropic-version': '2023-06-01',
      ...(apiKey === undefined ? {} : { 'x-api-key': apiKey }),
    }
  }
  return apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }
}

/** Validate one supplied key before it reaches the Fetch ByteString boundary. */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * Read a reply body without accepting more than the configured ceiling.
 *
 * A declared length is checked before transfer, while the accumulated bytes
 * enforce the same limit for chunked or deliberately under-declared replies.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${String(MAX_RESPONSE_BYTES)} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- Fetch exposes a body stream on every ordinary response; this is a defensive guard. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } catch (error: unknown) {
    if (error instanceof LlmError) throw error
    throw new LlmError(`${url} response body could not be read`, 'DISCOVERY_FAILED', { cause: error })
  } finally {
    /* v8 ignore next 4 -- best-effort cleanup after a completed or abandoned read. */
    await reader.cancel().catch(() => {
      // The response is already decided; cancellation failures cannot change it.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/** Parse one model-listing JSON document and discard unusable or duplicate rows. */
function readListing(body: unknown): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = label(entry?.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = label(entry?.name, entry?.display_name)
    const contextWindow = capacity(entry?.context_window, entry?.context_length)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens)
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
  }
  return models
}

/**
 * Interrogate one provider endpoint for the models it advertises.
 *
 * This function owns only protocol HTTP discovery. Catalog lookup, stored
 * credential resolution, and settings persistence remain responsibilities of
 * the caller that owns those concerns.
 *
 * @param request - endpoint, protocol, one-shot credential, and cancellation.
 * @returns advertised model metadata in endpoint order.
 * @throws LlmError when the protocol, endpoint, credential, response, or JSON
 *   listing cannot be used.
 */
export async function discoverModelsAtEndpoint(
  request: LlmEndpointModelDiscoveryRequest,
): Promise<readonly LlmDiscoveredModel[]> {
  const api = request.api ?? 'openai-completions'
  if (!supportsModelListing(api)) {
    throw new LlmError(
      `protocol ${api} has no model listing this build can read; enter models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  if (request.baseURL.trim() === '') {
    throw new LlmError('set a baseURL before discovering models', 'DISCOVERY_FAILED')
  }
  const url = listingUrl(request.baseURL, api)
  const apiKey = request.apiKey === undefined ? undefined : usableProbeKey(request.apiKey)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...listingHeaders(api, apiKey),
        ...attributionHeaders(),
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${String(response.status)}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
      { status: response.status },
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}
