import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverModelsAtEndpoint,
  MODEL_LISTING_PROTOCOLS,
  normalizeAnthropicBaseURL,
  supportsModelListing,
  userAgent,
} from '@deepseek-ai/dsh-llm'

afterEach(() => {
  vi.unstubAllGlobals()
})

type FetchRecord = { url: string; init: RequestInit }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubResponse(response: Response): FetchRecord[] {
  const requests: FetchRecord[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return response
  })
  return requests
}

describe('model listing protocol support', () => {
  it('publishes the supported protocols and rejects unknown ones', () => {
    expect(MODEL_LISTING_PROTOCOLS).toEqual([
      'anthropic-messages',
      'openai-completions',
      'openai-responses',
    ])
    for (const protocol of MODEL_LISTING_PROTOCOLS) expect(supportsModelListing(protocol)).toBe(true)
    expect(supportsModelListing('google-generative-ai')).toBe(false)
  })
})

describe('discoverModelsAtEndpoint', () => {
  it('normalizes only a trailing Anthropic version segment on a copied URL', () => {
    const input = new URL('https://gateway.example/tenant/v1/?region=cn')
    expect(normalizeAnthropicBaseURL(input).toString()).toBe('https://gateway.example/tenant?region=cn')
    expect(input.toString()).toBe('https://gateway.example/tenant/v1/?region=cn')
    expect(normalizeAnthropicBaseURL(new URL('https://gateway.example/tenant')).toString())
      .toBe('https://gateway.example/tenant')
  })

  it('requests an OpenAI listing, keeps deployment paths, and normalizes rows', async () => {
    const requests = stubResponse(jsonResponse({
      data: [
        {
          id: 'large',
          name: 42,
          display_name: 'Large',
          context_window: 0,
          context_length: 32_768,
          max_output_tokens: -1,
          max_tokens: 4096,
        },
        { id: 'large', display_name: 'duplicate' },
        { id: '' },
        null,
        { id: 'small', context_window: Number.MAX_SAFE_INTEGER + 1 },
      ],
    }))

    await expect(discoverModelsAtEndpoint({
      baseURL: '  https://gateway.example/openai/v1/?tenant=acme  ',
      api: 'openai-responses',
      apiKey: '  probe-key  ',
    })).resolves.toEqual([
      { id: 'large', name: 'Large', contextWindow: 32_768, maxTokens: 4096 },
      { id: 'small' },
    ])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://gateway.example/openai/v1/models?tenant=acme')
    const headers = new Headers(requests[0]?.init.headers)
    expect(requests[0]?.init.method).toBe('GET')
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('authorization')).toBe('Bearer probe-key')
    expect(headers.get('user-agent')).toBe(userAgent())
    expect(headers.get('x-api-key')).toBeNull()
  })

  it('uses the Anthropic /v1/models path and authentication headers', async () => {
    const requests = stubResponse(jsonResponse({ data: [{ id: 'claude-4', display_name: 'Claude 4' }] }))

    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example/anthropic/',
      api: 'anthropic-messages',
      apiKey: 'anthropic-key',
    })).resolves.toEqual([{ id: 'claude-4', name: 'Claude 4' }])

    expect(requests[0]?.url).toBe('https://gateway.example/anthropic/v1/models')
    const headers = new Headers(requests[0]?.init.headers)
    expect(headers.get('x-api-key')).toBe('anthropic-key')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('authorization')).toBeNull()
  })

  it('does not duplicate an existing Anthropic v1 path and permits unauthenticated probes', async () => {
    const requests = stubResponse(jsonResponse({ data: [] }))

    await discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example/v1/',
      api: 'anthropic-messages',
    })

    expect(requests[0]?.url).toBe('https://gateway.example/v1/models')
    const headers = new Headers(requests[0]?.init.headers)
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
  })

  it('rejects unsupported protocols and blank endpoints before fetching', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example', api: 'google-generative-ai' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
    await expect(discoverModelsAtEndpoint({ baseURL: '   ' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['relative', 'gateway.example'],
    ['non-http', 'ftp://gateway.example'],
    ['credentials', 'https://user:pass@gateway.example'],
    ['fragment', 'https://gateway.example/v1#models'],
  ])('rejects a %s baseURL', async (_label, baseURL) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(discoverModelsAtEndpoint({ baseURL })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['blank', '   '],
    ['non-ASCII', 'sk-密钥'],
  ])('rejects a supplied %s API key before fetching', async (_label, apiKey) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example', apiKey }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports HTTP failures with status and a key hint only for authentication failures', async () => {
    const unauthorized = stubResponse(jsonResponse({ error: 'nope' }, 401))
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example', apiKey: 'wrong' }))
      .rejects.toMatchObject({
        code: 'DISCOVERY_FAILED',
        failure: { status: 401 },
        message: expect.stringMatching(/check the API key/),
      })
    expect(unauthorized).toHaveLength(1)

    vi.unstubAllGlobals()
    const failed = stubResponse(jsonResponse({ error: 'boom' }, 500))
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example', apiKey: 'fine' }))
      .rejects.toMatchObject({
        code: 'DISCOVERY_FAILED',
        failure: { status: 500 },
        message: expect.stringMatching(/answered 500$/),
      })
    expect(failed).toHaveLength(1)
  })

  it('reports malformed JSON and a missing data array', async () => {
    stubResponse(new Response('not json', { status: 200 }))
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example' }))
      .rejects.toMatchObject({
        code: 'DISCOVERY_FAILED',
        message: expect.stringMatching(/did not answer with JSON/),
      })

    vi.unstubAllGlobals()
    stubResponse(jsonResponse({ models: [] }))
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example' }))
      .rejects.toThrow(/no "data" array/)
  })

  it('enforces the four-megabyte limit for declared and streamed responses', async () => {
    const oversized = `{"data":[{"id":"m","pad":"${'x'.repeat(4 * 1024 * 1024)}"}]}`
    stubResponse(new Response(oversized, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(oversized)) },
    }))
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example' }))
      .rejects.toThrow(/answered with more than 4194304 bytes/)

    vi.unstubAllGlobals()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized))
        controller.close()
      },
    })
    stubResponse(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example' }))
      .rejects.toThrow(/answered with more than 4194304 bytes/)
  })

  it('wraps a response body stream failure while preserving its cause', async () => {
    const cause = new Error('socket reset while reading model list')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(cause)
      },
    })
    stubResponse(new Response(stream, { status: 200 }))

    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example' }))
      .rejects.toMatchObject({
        code: 'DISCOVERY_FAILED',
        cause,
        message: 'https://gateway.example/models response body could not be read',
      })
  })

  it('maps fetch and body-read cancellation to ABORTED', async () => {
    const fetchCause = new Error('aborted before connect')
    const fetch = vi.fn(async () => { throw fetchCause })
    vi.stubGlobal('fetch', fetch)
    const alreadyAborted = AbortSignal.abort('caller stopped')
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example', signal: alreadyAborted }))
      .rejects.toMatchObject({ code: 'ABORTED', cause: fetchCause })

    vi.unstubAllGlobals()
    const controller = new AbortController()
    const bodyReady = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!(signal instanceof AbortSignal)) throw new Error('missing signal')
      return new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          bodyReady.resolve(undefined)
          return new Promise<undefined>((resolve) => {
            signal.addEventListener('abort', () => {
              stream.error(signal.reason)
              resolve(undefined)
            }, { once: true })
          })
        },
      }), { status: 200 })
    })
    const probe = discoverModelsAtEndpoint({ baseURL: 'https://gateway.example', signal: controller.signal })
    await bodyReady.promise
    controller.abort('caller stopped during body read')
    await expect(probe).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
