/** Fail-closed execution and receipt accounting without opening a network connection or browser. */
import { mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExistingLatencyConfig } from './config.ts'
import { operationId, resourceOperation } from './report.ts'

const launched = vi.hoisted(() => vi.fn(() => { throw new Error('This offline case must not open a browser') }))
vi.mock('../../apps/web/tests/computer-browser.ts', () => ({ launchComputerBrowser: launched }))
import { attachResourceTraceObservers, measureDeployment, observeAcceptedPrompt, renameTestSession, withFinalBrowserClock } from './runner.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  launched.mockClear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('uses the returned diagnostic UUID, retaining a request UUID only for an older response', () => {
  const sent = '11111111-1111-4111-8111-111111111111'
  const returned = '22222222-2222-4222-8222-222222222222'
  expect(operationId(returned, sent)).toBe(returned)
  expect(operationId(returned, undefined)).toBe(returned)
  expect(operationId(undefined, sent)).toBe(sent)
  expect(operationId(undefined, undefined)).toBeUndefined()
  expect(operationId('not-a-diagnostic-id', sent)).toBeUndefined()
  expect(operationId(undefined, 'application-request-id')).toBeUndefined()
})

it('classifies only the selected Runtime startup and file requests using fixed categories', () => {
  const target = { origin: 'https://qa.example.test', runtimeId: 'fixture-runtime', nodeId: 'fixture-node' }
  const pinned = 'dshRuntime=fixture-runtime&dshNode=fixture-node&dshTarget=personal'
  const document = `${target.origin}/?${pinned}`
  const classify = (method: string, path: string, referer?: string) =>
    resourceOperation(method, new URL(path, target.origin).href, referer, target)
  expect(classify('GET', `/?${pinned}&dshBootstrap=1`)).toBe('bootstrap')
  expect(classify('GET', `/?${pinned}&dshBootstrap=full`)).toBeUndefined()
  expect(classify('POST', `/api/workspaceFiles.readBytes?${pinned}`)).toBe('workspaceFilesReadBytes')
  expect(classify('GET', `/api/workspaceFiles.readBytes?${pinned}`)).toBeUndefined()
  const combo = '/plugins/combo.js??first/client.js,second/client.js&rev=abcdef123456&dshAssetPreload=1'
  expect(classify('GET', `${combo}&${pinned}`)).toBe('pluginCombo')
  expect(classify('GET', combo, document)).toBe('pluginCombo')
  expect(classify('GET', combo, 'not-a-url')).toBeUndefined()
  expect(classify('GET', combo, `https://other.example.test/?${pinned}`)).toBeUndefined()
  expect(classify('GET', `${combo}&dshRuntime=other`, document)).toBeUndefined()
  expect(classify('GET', `${combo}&${pinned}&dshRuntime=other`, document)).toBeUndefined()
  expect(classify('GET', `${combo}&dshAssetPreload=1&${pinned}`)).toBeUndefined()
  expect(classify('GET', `https://other.example.test${combo}&${pinned}`, document)).toBeUndefined()
})

describe.skipIf(process.platform === 'win32')('existing deployment preflight', () => {
  it('names through the ordinary route without requiring a versioned Runtime response header', async () => {
    const raw = JSON.parse(await readFile(new URL('./config.example.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const config = parseExistingLatencyConfig(raw)
    const evaluate = vi.fn(async (_callback: unknown, args: { rpcId: string; title: string }) => ({ status: 200,
      body: { rpcId: args.rpcId, result: { ok: true, value: { title: args.title, seq: 1 } } } }))
    // Playwright serializes this callback; the offline adapter returns only its ordinary RPC reply.
    const page = { evaluate } satisfies Parameters<typeof renameTestSession>[0]
    await expect(renameTestSession(page, config, 'test-session', 'QA_PERF_EXAMPLE_1')).resolves.toBeUndefined()
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ origin: config.origin,
      runtime: config.runtimeId, node: config.nodeId, account: config.accountId, session: 'test-session', title: 'QA_PERF_EXAMPLE_1' }))
    expect(launched).not.toHaveBeenCalled()
  })

  it('keeps a synced durable acknowledgement with operationId when the following browser observation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-existing-receipt-')); roots.push(root)
    const output = join(root, 'receipt.jsonl')
    const receipts = await open(output, 'wx', 0o600)
    const failure = new Error('fixture browser closed')
    const correlation = '33333333-3333-4333-8333-333333333333'
    const sample = { index: 2, operation: 'durable-send', outcome: 'failed', sessionId: 'qa-session',
      requestId: 'qa-request', receipt: 'status', operationId: correlation, httpStatus: 200 } as const
    try {
      await receipts.writeFile('{"kind":"plan"}\n{"kind":"sample","index":1}\n')
      const synced = vi.spyOn(receipts, 'sync')
      const observe = vi.fn(async () => {
        expect(synced).toHaveBeenCalledOnce()
        throw failure
      })
      await expect(observeAcceptedPrompt(receipts, sample, observe)).rejects.toBe(failure)
      expect(observe).toHaveBeenCalledOnce()
      const rows = (await readFile(output, 'utf8')).trim().split('\n').map((row): unknown => JSON.parse(row))
      expect(rows).toEqual([{ kind: 'plan' }, { kind: 'sample', index: 1 }, {
        kind: 'checkpoint', checkpoint: 'durable-send-accepted', operation: 'durable-send', index: 2,
        sessionId: 'qa-session', requestId: 'qa-request', receipt: 'status', operationId: correlation, httpStatus: 200,
      }])
    } finally { await receipts.close() }
  })

  it('preserves an earlier measurement failure when final browser clock collection fails after page closure', async () => {
    const original = new Error('accepted-turn-not-settled')
    const closed = new Error('Target page, context or browser has been closed')
    await expect(withFinalBrowserClock(async () => { throw original }, async () => { throw closed })).rejects.toBe(original)
    await expect(withFinalBrowserClock(async () => 'ok', async () => { throw closed })).rejects.toBe(closed)
    await expect(withFinalBrowserClock(async () => 'ok', async () => {})).resolves.toBe('ok')
  })

  it('records bounded resourceTraces and split boot/setup API summaries without retaining URLs or bodies', () => {
    const listeners = {
      request: [] as Array<(request: unknown) => void>,
      response: [] as Array<(response: unknown) => void>,
      requestfailed: [] as Array<(request: unknown) => void>,
    }
    const page = {
      on(event: 'request' | 'response' | 'requestfailed', listener: (value: unknown) => void) {
        listeners[event].push(listener)
      },
    }
    const target = { origin: 'https://qa.example.test', runtimeId: 'fixture-runtime', nodeId: 'fixture-node' }
    const pinned = 'dshRuntime=fixture-runtime&dshNode=fixture-node&dshTarget=personal'
    let stage = 'initial-navigation'
    const { resourceTraces, initialRpcSummary } = attachResourceTraceObservers(page as never, target, () => stage)
    const makeRequest = (method: string, path: string, headers: Record<string, string> = {}, errorText?: string) => ({
      method: () => method,
      url: () => new URL(path, target.origin).href,
      headers: () => headers,
      failure: () => errorText === undefined ? null : { errorText },
    })
    const bootReq = makeRequest('GET', `/?${pinned}&dshBootstrap=1`, { 'x-dsh-operation-id': '11111111-1111-4111-8111-111111111111' })
    for (const fn of listeners.request) fn(bootReq)
    for (const fn of listeners.response) {
      fn({
        request: () => bootReq,
        status: () => 200,
        headers: () => ({ 'x-dsh-operation-id': '22222222-2222-4222-8222-222222222222' }),
      })
    }
    const failedFile = makeRequest('POST', `/api/workspaceFiles.list?${pinned}&secret=ignored`, {}, 'net::ERR_TIMED_OUT')
    for (const fn of listeners.request) fn(failedFile)
    for (const fn of listeners.requestfailed) fn(failedFile)
    const rpcReq = makeRequest('POST', `/api/settings.describe?${pinned}`)
    for (const fn of listeners.request) fn(rpcReq)
    for (const fn of listeners.response) fn({ request: () => rpcReq, status: () => 200, headers: () => ({}) })
    const runtimesReq = makeRequest('GET', '/account/api/runtimes?ids=123')
    for (const fn of listeners.request) fn(runtimesReq)
    for (const fn of listeners.response) fn({ request: () => runtimesReq, status: () => 200, headers: () => ({}) })
    stage = 'initial-history-click'
    const historyReq = makeRequest('POST', `/api/prepare/v1/session.history?${pinned}`)
    for (const fn of listeners.request) fn(historyReq)
    for (const fn of listeners.response) fn({ request: () => historyReq, status: () => 200, headers: () => ({}) })
    stage = 'hot-create'
    for (const fn of listeners.request) fn(makeRequest('POST', `/api/settings.describe?${pinned}`))
    for (let i = 0; i < 40; i++) {
      for (const fn of listeners.request) fn(makeRequest('POST', `/api/workspaceFiles.list?${pinned}`))
    }
    expect(resourceTraces).toHaveLength(32)
    expect(resourceTraces[0]).toEqual({
      stage: 'initial-navigation', operation: 'bootstrap', status: 200,
      operationId: '22222222-2222-4222-8222-222222222222',
    })
    expect(resourceTraces[1]).toEqual({
      stage: 'initial-navigation', operation: 'workspaceFilesList', failure: 'net::ERR_TIMED_OUT',
    })
    expect(initialRpcSummary.boot['/api/workspaceFiles.list']).toEqual({ count: 1, statuses: { failed: 1 } })
    expect(initialRpcSummary.boot['/api/settings.describe']).toMatchObject({ count: 1, statuses: { '200': 1 } })
    expect(typeof initialRpcSummary.boot['/api/settings.describe']?.maxMs).toBe('number')
    expect(initialRpcSummary.boot['/account/api/runtimes']).toMatchObject({ count: 1, statuses: { '200': 1 } })
    expect(initialRpcSummary.setup['/api/prepare/v1/session.history']).toMatchObject({ count: 1, statuses: { '200': 1 } })
    expect(initialRpcSummary.setup['/api/settings.describe']).toBeUndefined()
  })

  it('retains a stopped-Runtime result with fifty unattempted actions and releases only its own lock', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-existing-preflight-'))); roots.push(root)
    const raw = JSON.parse(await readFile(new URL('./config.example.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const config = parseExistingLatencyConfig({ ...raw, authenticationFile: join(root, 'cookie'), outputFile: join(root, 'receipt.jsonl') })
    await writeFile(config.authenticationFile, 'qa_cookie=offline-only-placeholder', { mode: 0o600 })
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ items: [{ id: config.runtimeId,
      owner: { kind: 'personal', id: config.accountId }, node: { id: config.nodeId, name: config.computerName, status: 'active' }, observedState: 'stopped' }] }))
    const result = await measureDeployment(config)
    expect(result).toMatchObject({ complete: false, stopped: { error: 'runtime-not-hot' }, result: {
      'hot-create': { expected: 50, attempted: 0, notRun: 50 }, 'hot-open': { expected: 50, attempted: 0, notRun: 50 },
      'durable-send': { expected: 50, attempted: 0, notRun: 50 },
    } })
    expect(transport).toHaveBeenCalledOnce()
    expect(launched).not.toHaveBeenCalled()
    const receipt = await readFile(config.outputFile, 'utf8')
    expect(receipt.trim().split('\n').map(row => (JSON.parse(row) as { kind: string }).kind)).toEqual(['plan', 'summary'])
    expect(receipt).not.toContain('offline-only-placeholder')
    expect(receipt).not.toContain(config.workspacePath)
    expect((await readdir(root)).sort()).toEqual(['cookie', 'receipt.jsonl'])
    await expect(readFile(config.authenticationFile, 'utf8')).resolves.toBe('qa_cookie=offline-only-placeholder')
    const retry = await measureDeployment(config)
    expect(retry).toMatchObject({ complete: false })
    expect(transport).toHaveBeenCalledOnce()
    expect(await readFile(config.outputFile, 'utf8')).toBe(receipt)
  })
})
