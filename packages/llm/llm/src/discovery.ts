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

/** Response facts used to decide whether an endpoint path is mismatched. */
export interface LlmEndpointResponseMetadata {
  /** HTTP status returned before the body was consumed. */
  status: number
  /** Response headers with provider-preserved names. */
  headers: Readonly<Record<string, string>>
}

/** A process-local resolution cache; it never stores credentials or bodies. */
export class LlmEndpointResolutionCache {
  private readonly entries = new Map<string, string>()
  private generationValue = 0

  /**
   * Read a previously successful base URL.
   * @param api - selected wire protocol.
   * @param baseURL - raw profile base URL.
   * @returns the successful candidate, or `undefined` when none is cached.
   */
  get(api: string, baseURL: string): string | undefined {
    return this.entries.get(endpointCacheKey(api, baseURL))
  }

  /** Monotonic invalidation generation for owners coordinating snapshots. */
  get generation(): number {
    return this.generationValue
  }

  /**
   * Store a successful candidate for one raw profile endpoint.
   * @param api - selected wire protocol.
   * @param baseURL - raw profile base URL.
   * @param resolvedBaseURL - candidate base URL that answered successfully.
   */
  set(api: string, baseURL: string, resolvedBaseURL: string): void {
    this.entries.set(endpointCacheKey(api, baseURL), resolvedBaseURL)
  }

  /**
   * Forget a candidate after the provider reports a path mismatch.
   * @param api - selected wire protocol.
   * @param baseURL - raw profile base URL.
   */
  delete(api: string, baseURL: string): void {
    this.entries.delete(endpointCacheKey(api, baseURL))
  }

  /** Drop every entry when the owning profile snapshot changes. */
  clear(): void {
    this.entries.clear()
    this.generationValue += 1
  }
}

/** Stable cache key that contains no credential or response data. */
function endpointCacheKey(api: string, baseURL: string): string {
  return `${api}\0${baseURL.trim()}`
}

/**
 * Normalize a parsed Anthropic endpoint before the SDK appends `/v1/messages`.
 * A copy is returned so callers retain ownership of their URL object.
 *
 * @param baseURL - validated endpoint URL, possibly ending in `/v1`.
 * @returns an endpoint URL without one trailing Anthropic version segment.
 */
export function normalizeAnthropicBaseURL(baseURL: URL): URL {
  const normalized = new URL(baseURL)
  const path = normalized.pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1')) normalized.pathname = path.slice(0, -'/v1'.length) || '/'
  return normalized
}

/**
 * Return the exact base URL and, for OpenAI protocols, its `/v1` toggle.
 * Anthropic's SDK owns the `/v1/messages` suffix, so it receives one
 * normalized candidate instead of two equivalent requests.
 *
 * @param rawBaseURL - validated HTTP(S) endpoint prefix.
 * @param api - selected wire protocol.
 * @returns ordered unique candidate base URLs, exact input first.
 * @throws LlmError when the base URL is not an absolute HTTP(S) URL without
 *   credentials or a fragment.
 */
export function modelEndpointCandidates(rawBaseURL: string, api: string): readonly [string, ...string[]] {
  const value = rawBaseURL.trim()
  let base: URL
  try {
    base = new URL(value)
  } catch (error: unknown) {
    throw new LlmError('baseURL must be an absolute http or https URL', 'DISCOVERY_FAILED', { cause: error })
  }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:')
    || base.username !== '' || base.password !== '' || base.hash !== '') {
    throw new LlmError('baseURL must be an absolute http or https URL without credentials or a fragment', 'DISCOVERY_FAILED')
  }
  const exact = base.toString()
  if (api === 'anthropic-messages') return [normalizeAnthropicBaseURL(base).toString()]
  if (api !== 'openai-completions' && api !== 'openai-responses') return [exact]
  const alternate = new URL(base)
  const path = alternate.pathname.replace(/\/+$/, '')
  alternate.pathname = path.endsWith('/v1')
    ? path.slice(0, -'/v1'.length) || '/'
    : `${path}/v1`
  const toggled = alternate.toString()
  return [exact, toggled]
}

/** Read one response media type without depending on header-name casing. */
function endpointMediaType(response: LlmEndpointResponseMetadata): string | undefined {
  const contentType = Object.entries(response.headers)
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1]
  return contentType?.split(';', 1)[0]?.trim().toLowerCase()
}

/**
 * Decide whether a response has an explicit content type for another protocol.
 *
 * @param response - status and headers captured before body consumption.
 * @param expected - media type the caller asked the endpoint to produce.
 * @returns `true` for a successful response whose declared type is incompatible.
 */
export function isEndpointContentTypeMismatch(
  response: LlmEndpointResponseMetadata,
  expected: 'application/json' | 'text/event-stream',
): boolean {
  if (response.status < 200 || response.status >= 300) return false
  const mediaType = endpointMediaType(response)
  if (mediaType === undefined) return false
  if (expected === 'application/json') return mediaType !== 'application/json' && !mediaType.endsWith('+json')
  return mediaType !== expected
}

/**
 * Decide whether an HTTP response identifies a wrong endpoint path rather
 * than a provider or network failure for a streaming request.
 *
 * @param response - status and headers captured before body consumption.
 * @returns `true` for 404/405 or an explicit non-SSE successful response.
 */
export function isEndpointPathMismatch(response: LlmEndpointResponseMetadata): boolean {
  return response.status === 404 || response.status === 405
    || isEndpointContentTypeMismatch(response, 'text/event-stream')
}

/** Whether a model-listing response is an explicit website/path mismatch. */
function isListingPathMismatch(response: LlmEndpointResponseMetadata): boolean {
  if (response.status === 404 || response.status === 405) return true
  if (response.status < 200 || response.status >= 300) return false
  return endpointMediaType(response) === 'text/html'
}

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

/** Build a model-listing URL from one already validated candidate base URL. */
function listingUrl(candidate: string, api: ModelListingProtocol): string {
  const endpoint = new URL(candidate)
  const path = endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = `${path}${api === 'anthropic-messages' ? '/v1' : ''}/models`
  return endpoint.toString()
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

/** The successful endpoint and the candidates it advertised. */
export interface LlmEndpointModelDiscoveryResult {
  /** Models returned by the successful listing response. */
  readonly models: readonly LlmDiscoveredModel[]
  /** Base URL to use for subsequent requests in this process. */
  readonly baseURL: string
}

/** Cancel a discarded candidate response without masking the selected error. */
async function cancelCandidate(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The candidate is already rejected; a body-cancellation failure cannot change that result.
  }
}

/** Order candidates with a previously successful URL first. */
function orderedCandidates(
  rawBaseURL: string,
  api: string,
  cache: LlmEndpointResolutionCache | undefined,
): readonly [string, ...string[]] {
  const candidates = [...modelEndpointCandidates(rawBaseURL, api)]
  const cached = cache?.get(api, rawBaseURL)
  if (cached === undefined || !candidates.includes(cached)) {
    if (cached !== undefined) cache?.delete(api, rawBaseURL)
    return candidates as [string, ...string[]]
  }
  return [cached, ...candidates.filter(candidate => candidate !== cached)] as [string, ...string[]]
}

/** Fetch one candidate listing and classify only explicit path mismatches for fallback. */
async function fetchListingCandidate(
  request: LlmEndpointModelDiscoveryRequest,
  api: ModelListingProtocol,
  baseURL: string,
  apiKey: string | undefined,
): Promise<{ kind: 'ok'; models: LlmDiscoveredModel[] } | { kind: 'path-mismatch'; url: string }> {
  const url = listingUrl(baseURL, api)
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
  const metadata: LlmEndpointResponseMetadata = {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
  }
  if (!response.ok) {
    if (isListingPathMismatch(metadata)) {
      await cancelCandidate(response)
      return { kind: 'path-mismatch', url }
    }
    throw new LlmError(
      `${url} answered ${String(response.status)}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
      { status: response.status },
    )
  }
  if (isListingPathMismatch(metadata)) {
    await cancelCandidate(response)
    return { kind: 'path-mismatch', url }
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
  return { kind: 'ok', models: readListing(body) }
}

/**
 * Interrogate candidate endpoint prefixes and return the one that answered.
 * Only explicit endpoint-path mismatches advance to the next candidate.
 *
 * @param request - endpoint, protocol, one-shot credential, and cancellation.
 * @param cache - optional process-local cache shared with the requesting adapter.
 * @returns model metadata and the successful base URL.
 * @throws LlmError when no candidate can provide a usable listing.
 */
export async function discoverModelListingAtEndpoint(
  request: LlmEndpointModelDiscoveryRequest,
  cache?: LlmEndpointResolutionCache,
): Promise<LlmEndpointModelDiscoveryResult> {
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
  const candidates = orderedCandidates(request.baseURL, api, cache)
  const apiKey = request.apiKey === undefined ? undefined : usableProbeKey(request.apiKey)
  const cacheGeneration = cache?.generation
  const mismatches: string[] = []
  for (const [index, baseURL] of candidates.entries()) {
    const result = await fetchListingCandidate(request, api, baseURL, apiKey)
    if (result.kind === 'ok') {
      if (cache !== undefined && cache.generation === cacheGeneration) {
        cache.set(api, request.baseURL, baseURL)
      }
      return { models: result.models, baseURL }
    }
    mismatches.push(result.url)
    if (index === candidates.length - 1) {
      throw new LlmError(
        `model listing was not available at any candidate endpoint: ${mismatches.join(', ')}`,
        'DISCOVERY_FAILED',
      )
    }
  }
  /* v8 ignore next -- candidates is a non-empty tuple, so the loop always returns or throws. */
  throw new LlmError('model discovery produced no endpoint candidates', 'DISCOVERY_FAILED')
}

/**
 * Interrogate one provider endpoint for the models it advertises.
 *
 * This function owns only protocol HTTP discovery. Catalog lookup, stored
 * credential resolution, and settings persistence remain responsibilities of
 * the caller that owns those concerns.
 *
 * @param request - endpoint, protocol, one-shot credential, and cancellation.
 * @param cache - optional process-local cache shared by discovery and requests.
 * @returns advertised model metadata in endpoint order.
 * @throws LlmError when the protocol, endpoint, credential, response, or JSON
 *   listing cannot be used.
 */
export async function discoverModelsAtEndpoint(
  request: LlmEndpointModelDiscoveryRequest,
  cache?: LlmEndpointResolutionCache,
): Promise<readonly LlmDiscoveredModel[]> {
  return (await discoverModelListingAtEndpoint(request, cache)).models
}
