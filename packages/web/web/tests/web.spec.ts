import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime, {
  readWebResponseBytes,
  readWebResponseJson,
  WebResponseTooLargeError,
  DEFAULT_WEB_RESPONSE_MAX_BYTES,
  WebError,
  type WebFetchProvider,
  type WebFetchResult,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web'

/** A scripted search provider for contract tests. */
function makeSearchProvider(
  id: string,
  available: boolean,
  search: (request: WebSearchRequest) => Promise<WebSearchResult>,
): WebSearchProvider {
  return { id, available: () => available, search: request => search(request) }
}

function makeFetchProvider(id: string, available: boolean, result: WebFetchResult): WebFetchProvider {
  return { id, available: () => available, fetch: () => Promise.resolve(result) }
}

const available = true
const unavailable = false

function searchResult(marker: string, overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return { content: marker, sources: [], truncated: false, ...overrides }
}

function fetchResult(marker: string): WebFetchResult {
  return { url: 'https://example.com', statusCode: 200, body: { kind: 'text', content: marker }, truncated: false }
}

/** Mount a WebRuntime on a fresh root context with the given config. */
async function mountWeb(config: ConstructorParameters<typeof WebRuntime>[1] = {}): Promise<{ ctx: Context; web: WebRuntime }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, config)
  return { ctx, web: ctx.web }
}

describe('WebRuntime registration', () => {
  it('registers a search provider and unregisters it via the returned disposer', async () => {
    const { web } = await mountWeb()

    const dispose = web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })

    dispose()
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws WEB_DUPLICATE_PROVIDER on a duplicate search id', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    expect(() => web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa')))))
      .toThrow(expect.objectContaining({ code: 'WEB_DUPLICATE_PROVIDER' }))
  })

  it('keeps search and fetch id namespaces independent', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('shared', available, () => Promise.resolve(searchResult('shared'))))
    expect(() => web.registerFetchProvider(makeFetchProvider('shared', available, fetchResult('shared')))).not.toThrow()
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, web } = await mountWeb()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    }, { inject: ['web'] }))
    await expect(web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })
    await fiber.dispose()
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })
})

describe('WebRuntime execution resolution', () => {
  it('throws WEB_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { web } = await mountWeb()
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_UNAVAILABLE when providers exist but none are usable', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { web } = await mountWeb({ searchProvider: 'perplexity' })
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('throws WEB_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { web } = await mountWeb({ searchProvider: 'exa' })
    web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_AMBIGUOUS rather than picking by order', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_AMBIGUOUS' }))
  })

  it('runs the configured provider even when another usable provider is registered', async () => {
    const { web } = await mountWeb({ searchProvider: 'perplexity' })
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    await expect(web.search({ query: 'q' })).resolves.toMatchObject({ content: 'perplexity' })
  })

  it('ignores unusable providers when auto-selecting', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', unavailable, () => Promise.resolve(searchResult('perplexity'))))
    await expect(web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })
  })

  it('does not let registration order change auto-selection', async () => {
    const a = await mountWeb()
    a.web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    a.web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    await expect(a.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'perplexity' })

    const b = await mountWeb()
    b.web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    b.web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    await expect(b.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'perplexity' })
  })

  it('runs the selected provider and returns its result', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(
      searchResult('exa', { content: 'answer', sources: [{ url: 'https://a' }] }),
    )))
    const result = await web.search({ query: 'q' })
    expect(result.content).toBe('answer')
    expect(result.sources).toEqual([{ url: 'https://a' }])
  })

  it('propagates the abort signal to the provider', async () => {
    const { web } = await mountWeb()
    const seen: (AbortSignal | undefined)[] = []
    web.registerSearchProvider({
      id: 'exa',
      available: () => available,
      search: (_request, signal) => { seen.push(signal); return Promise.resolve(searchResult('exa')) },
    })
    const controller = new AbortController()
    await web.search({ query: 'q' }, controller.signal)
    expect(seen[0]).toBe(controller.signal)
  })
})

describe('WebRuntime maxResults enforcement', () => {
  it('truncates sources and sets truncated when a provider over-returns', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }, { url: 'https://2' }, { url: 'https://3' }],
    }))))
    const result = await web.search({ query: 'q', maxResults: 2 })
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('leaves truncated false when within the bound', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }],
    }))))
    const result = await web.search({ query: 'q', maxResults: 8 })
    expect(result.sources).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('does not bound when maxResults is omitted', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }, { url: 'https://2' }],
    }))))
    const result = await web.search({ query: 'q' })
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})

describe('WebRuntime fetch capability', () => {
  it('resolves and runs the fetch provider independently of search', async () => {
    const { web } = await mountWeb()
    web.registerFetchProvider(makeFetchProvider('http', available, fetchResult('http')))
    const result = await web.fetch({ url: 'https://example.com' })
    expect(result.body.content).toBe('http')
    expect(result.statusCode).toBe(200)
  })

  it('throws WEB_PROVIDER_UNAVAILABLE for fetch when no fetch provider is registered', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    await expect(web.fetch({ url: 'https://example.com' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }),
    )
  })
})

describe('WebError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new WebError('boom', 'WEB_INVALID_URL')
    expect(error.code).toBe('WEB_INVALID_URL')
    expect(error.name).toBe('WebError')
  })
})

describe('bounded web provider response readers', () => {
  it('reads a response within the byte budget and parses JSON', async () => {
    const response = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    await expect(readWebResponseJson(response, DEFAULT_WEB_RESPONSE_MAX_BYTES)).resolves.toEqual({ ok: true })
  })

  it('rejects a declared response larger than the budget before consuming it', async () => {
    const response = new Response('{}', { headers: { 'content-length': '99' } })
    await expect(readWebResponseBytes(response, 4)).rejects.toBeInstanceOf(WebResponseTooLargeError)
  })

  it('cancels a chunked response when a later chunk crosses the budget', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3))
        controller.enqueue(Uint8Array.of(4, 5))
      },
      cancel() { cancelled = true },
    })
    const response = new Response(body)
    await expect(readWebResponseBytes(response, 4)).rejects.toBeInstanceOf(WebResponseTooLargeError)
    expect(cancelled).toBe(true)
  })

  it('preserves an abort rejection from a response-shaped test carrier', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const response = { body: undefined, json: () => Promise.reject(abort) }
    await expect(readWebResponseJson(response as unknown as Response, 32)).rejects.toBe(abort)
  })

  it('rejects a configured response budget above the hard maximum', async () => {
    await expect(readWebResponseBytes(new Response('{}'), 256 * 1024 * 1024 + 1))
      .rejects.toThrow(/within 1/u)
  })
})
