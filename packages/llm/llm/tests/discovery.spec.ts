import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverModelListingAtEndpoint,
  discoverModelsAtEndpoint,
  isEndpointContentTypeMismatch,
  isEndpointPathMismatch,
  LlmEndpointResolutionCache,
  MODEL_LISTING_PROTOCOLS,
  modelEndpointCandidates,
  normalizeAnthropicBaseURL,
  supportsModelListing,
  userAgent,
} from '@deepseek-ai/dsh-llm'

afterEach(() => {
  vi.unstubAllGlobals()
})

type FetchRecord = { url: string; init: RequestInit }

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubResponse(response: Response): FetchRecord[] {
  const requests: FetchRecord[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: requestUrl(input), init: init ?? {} })
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

describe('endpoint candidate resolution', () => {
  it('toggles one trailing v1 for OpenAI protocols and normalizes Anthropic once', () => {
    expect(modelEndpointCandidates('https://gateway.example/openai', 'openai-completions'))
      .toEqual(['https://gateway.example/openai', 'https://gateway.example/openai/v1'])
    expect(modelEndpointCandidates('https://gateway.example/openai/v1/?tenant=acme', 'openai-responses'))
      .toEqual(['https://gateway.example/openai/v1/?tenant=acme', 'https://gateway.example/openai?tenant=acme'])
    expect(modelEndpointCandidates('https://gateway.example/anthropic/v1', 'anthropic-messages'))
      .toEqual(['https://gateway.example/anthropic'])
    expect(modelEndpointCandidates('https://gateway.example/custom', 'google-generative-ai'))
      .toEqual(['https://gateway.example/custom'])
  })

  it('keeps cache operations scoped to protocol and raw base URL', () => {
    const cache = new LlmEndpointResolutionCache()
    expect(cache.generation).toBe(0)
    expect(cache.get('openai-completions', 'https://gateway.example')).toBeUndefined()
    cache.set('openai-completions', 'https://gateway.example', 'https://gateway.example/v1')
    expect(cache.get('openai-completions', 'https://gateway.example')).toBe('https://gateway.example/v1')
    expect(cache.get('openai-responses', 'https://gateway.example')).toBeUndefined()
    cache.delete('openai-completions', 'https://gateway.example')
    expect(cache.get('openai-completions', 'https://gateway.example')).toBeUndefined()
    cache.set('openai-completions', 'https://gateway.example', 'https://gateway.example/v1')
    cache.clear()
    expect(cache.get('openai-completions', 'https://gateway.example')).toBeUndefined()
    expect(cache.generation).toBe(1)
  })

  it('classifies only explicit status or content-type path mismatches', () => {
    expect(isEndpointPathMismatch({ status: 404, headers: {} })).toBe(true)
    expect(isEndpointPathMismatch({ status: 405, headers: {} })).toBe(true)
    expect(isEndpointPathMismatch({ status: 401, headers: { 'content-type': 'text/html' } })).toBe(false)
    expect(isEndpointPathMismatch({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })).toBe(true)
    expect(isEndpointPathMismatch({ status: 200, headers: { 'content-type': 'text/event-stream' } })).toBe(false)
    expect(isEndpointContentTypeMismatch({ status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }, 'application/json')).toBe(false)
    expect(isEndpointContentTypeMismatch({ status: 200, headers: { 'content-type': 'application/problem+json' } }, 'application/json')).toBe(false)
    expect(isEndpointContentTypeMismatch({ status: 200, headers: {} }, 'text/event-stream')).toBe(false)
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

  it('falls back from an HTML root listing to /v1 and remembers the result', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://gateway.example/models') {
        return new Response('<html>landing page</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      return jsonResponse({ data: [{ id: 'relay-model' }] })
    })
    const cache = new LlmEndpointResolutionCache()
    const request = { baseURL: 'https://gateway.example', api: 'openai-completions' }

    await expect(discoverModelListingAtEndpoint(request, cache)).resolves.toEqual({
      models: [{ id: 'relay-model' }],
      baseURL: 'https://gateway.example/v1',
    })
    await expect(discoverModelListingAtEndpoint(request, cache)).resolves.toEqual({
      models: [{ id: 'relay-model' }],
      baseURL: 'https://gateway.example/v1',
    })
    expect(requests).toEqual([
      'https://gateway.example/models',
      'https://gateway.example/v1/models',
      'https://gateway.example/v1/models',
    ])
  })

  it('falls back from a 404 listing path and from a supplied /v1 path', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/v1/')) return jsonResponse({ error: 'missing' }, 404)
      return jsonResponse({ data: [{ id: 'relay-model' }] })
    })
    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example/v1',
      api: 'openai-completions',
    })).resolves.toEqual([{ id: 'relay-model' }])
    expect(requests).toEqual([
      'https://gateway.example/v1/models',
      'https://gateway.example/models',
    ])
  })

  it('does not fall back after a network failure or an ordinary malformed body', async () => {
    const networkRequests: string[] = []
    const networkFailure = new Error('connection refused')
    vi.stubGlobal('fetch', async (input: string | URL) => {
      networkRequests.push(String(input))
      throw networkFailure
    })
    await expect(discoverModelListingAtEndpoint({
      baseURL: 'https://gateway.example',
      api: 'openai-completions',
    })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED', cause: networkFailure })
    expect(networkRequests).toEqual(['https://gateway.example/models'])

    vi.unstubAllGlobals()
    const malformedRequests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      malformedRequests.push(String(input))
      return new Response('not json', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    })
    await expect(discoverModelListingAtEndpoint({
      baseURL: 'https://gateway.example',
      api: 'openai-completions',
    })).rejects.toThrow(/did not answer with JSON/)
    expect(malformedRequests).toEqual(['https://gateway.example/models'])

    vi.unstubAllGlobals()
    const serverFailureRequests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      serverFailureRequests.push(String(input))
      return new Response('<html>temporarily unavailable</html>', {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
    await expect(discoverModelListingAtEndpoint({
      baseURL: 'https://gateway.example',
      api: 'openai-completions',
    })).rejects.toMatchObject({ failure: { status: 500 } })
    expect(serverFailureRequests).toEqual(['https://gateway.example/models'])
  })

  it('reports both path candidates when neither can list models', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      requests.push(String(input))
      return jsonResponse({ error: 'missing' }, 404)
    })
    await expect(discoverModelListingAtEndpoint({
      baseURL: 'https://gateway.example',
      api: 'openai-responses',
    })).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: expect.stringContaining('https://gateway.example/models') as unknown,
    })
    expect(requests).toEqual([
      'https://gateway.example/models',
      'https://gateway.example/v1/models',
    ])
  })

  it('drops a cached candidate that is no longer part of the regenerated options', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      requests.push(String(input))
      return jsonResponse({ data: [{ id: 'relay-model' }] })
    })
    const cache = new LlmEndpointResolutionCache()
    cache.set('openai-completions', 'https://gateway.example', 'https://other.example/v1')
    await discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example',
      api: 'openai-completions',
    }, cache)
    expect(requests).toEqual(['https://gateway.example/models'])
    expect(cache.get('openai-completions', 'https://gateway.example')).toBe('https://gateway.example/')
  })

  it('does not publish a stale discovery result after cache invalidation', async () => {
    const cache = new LlmEndpointResolutionCache()
    const fetch = vi.fn(async () => {
      cache.clear()
      return jsonResponse({ data: [{ id: 'relay-model' }] })
    })
    vi.stubGlobal('fetch', fetch)

    await expect(discoverModelListingAtEndpoint({
      baseURL: 'https://gateway.example',
      api: 'openai-completions',
    }, cache)).resolves.toMatchObject({ baseURL: 'https://gateway.example/' })
    expect(cache.get('openai-completions', 'https://gateway.example')).toBeUndefined()
  })

  it('does not hide authentication failures behind an alternate path', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      requests.push(String(input))
      return jsonResponse({ error: 'wrong key' }, 401)
    })

    await expect(discoverModelListingAtEndpoint({
      baseURL: 'https://gateway.example',
      api: 'openai-completions',
      apiKey: 'wrong',
    })).rejects.toMatchObject({ failure: { status: 401 } })
    expect(requests).toEqual(['https://gateway.example/models'])
  })

  it('keeps a relay balance diagnostic from a JSON authorization response', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({
      code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance',
    }, 403))
    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example', api: 'anthropic-messages', apiKey: 'relay-key',
    })).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: expect.stringContaining('INSUFFICIENT_BALANCE: Insufficient account balance') as unknown,
      failure: { status: 403 },
    })
  })

  it('recognizes account-qualified insufficient-balance wording without an error code', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ message: 'Insufficient account balance' }, 403))
    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example', api: 'anthropic-messages', apiKey: 'relay-key',
    })).rejects.toMatchObject({
      message: expect.not.stringContaining('check the API key') as unknown,
    })
  })

  it('redacts a credential echoed by a provider error', async () => {
    const key = 'relay-secret-key'
    vi.stubGlobal('fetch', async () => jsonResponse({
      code: 'AUTH_FAILED', message: `the supplied key ${key} was rejected`,
    }, 401))
    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example', api: 'openai-completions', apiKey: key,
    })).rejects.toMatchObject({
      message: expect.stringContaining('[redacted]') as unknown,
    })
    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example', api: 'openai-completions', apiKey: key,
    })).rejects.not.toThrow(key)
  })

  it('keeps payment-required relay diagnostics', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({
      type: 'quota_error', message: 'credits exhausted',
    }, 402))
    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example', api: 'openai-completions', apiKey: 'relay-key',
    })).rejects.toMatchObject({
      message: expect.stringContaining('quota_error: credits exhausted') as unknown,
      failure: { status: 402 },
    })
  })

  it.each([
    ['an empty body', '', undefined, []],
    ['an HTML error page', '<html><body>Forbidden</body></html>', undefined, []],
    ['a plain-text body', 'upstream relay refused the key', undefined, ['upstream relay refused the key']],
    ['a JSON array', '[1, 2]', undefined, []],
    ['a JSON object with no diagnostic fields', '{"status":"nope"}', undefined, []],
    ['a nested error object', '{"error":{"code":"E_AUTH","type":"auth","message":"bad key"}}', 'relay-key', ['E_AUTH: auth: bad key']],
    ['a nested error string', '{"error":"quota reached"}', 'relay-key', ['quota reached']],
    ['an overlong diagnostic', JSON.stringify({ message: 'm'.repeat(300) }), 'relay-key', [`${'m'.repeat(239)}…`]],
  ] as const)('summarizes %s from a provider error body', async (_label, body, apiKey, expectedFragments) => {
    vi.stubGlobal('fetch', async () => new Response(body, { status: 401, headers: { 'content-type': 'text/plain' } }))
    const error = await discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example', api: 'openai-completions', ...(apiKey === undefined ? {} : { apiKey }),
    }).then(() => undefined, (reason: unknown) => reason as Error)
    if (error === undefined) throw new Error('discovery must fail on 401')
    expect(error).toMatchObject({ code: 'DISCOVERY_FAILED', failure: { status: 401 } })
    for (const fragment of expectedFragments) expect(error.message).toContain(fragment)
    if (expectedFragments.length === 0 && body !== '') expect(error.message).not.toContain(body)
  })

  it('drops the diagnostic when a provider error body exceeds the response bound', async () => {
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(16), {
      status: 429, headers: { 'content-type': 'text/plain', 'content-length': String(8 * 1024 * 1024) },
    }))
    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example', api: 'openai-completions', apiKey: 'k',
    })).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: expect.not.stringContaining('xxxx') as unknown,
      failure: { status: 429 },
    })
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

  it('tries an unversioned Anthropic model directory when a relay omits /v1', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      requests.push(String(input))
      return requests.length === 1
        ? new Response('', { status: 404 })
        : jsonResponse({ data: [{ id: 'claude-relay' }] })
    })

    await expect(discoverModelsAtEndpoint({
      baseURL: 'https://gateway.example/v1',
      api: 'anthropic-messages',
    })).resolves.toEqual([{ id: 'claude-relay' }])
    expect(requests).toEqual([
      'https://gateway.example/v1/models',
      'https://gateway.example/models',
    ])
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
        message: expect.stringMatching(/check the API key/) as unknown,
      })
    expect(unauthorized).toHaveLength(1)

    vi.unstubAllGlobals()
    const failed = stubResponse(jsonResponse({ error: 'boom' }, 500))
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example', apiKey: 'fine' }))
      .rejects.toMatchObject({
        code: 'DISCOVERY_FAILED',
        failure: { status: 500 },
        message: expect.stringMatching(/answered 500$/) as unknown,
      })
    expect(failed).toHaveLength(1)
  })

  it('reports malformed JSON and a missing data array', async () => {
    stubResponse(new Response('not json', { status: 200 }))
    await expect(discoverModelsAtEndpoint({ baseURL: 'https://gateway.example' }))
      .rejects.toMatchObject({
        code: 'DISCOVERY_FAILED',
        message: expect.stringMatching(/did not answer with JSON/) as unknown,
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
