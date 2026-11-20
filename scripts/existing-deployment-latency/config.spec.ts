/** Offline safety and aggregation checks; no browser, HTTP listener or Runtime is acquired. */
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measurementArguments, measureExistingDeployment } from '../measure-existing-deployment.ts'
import { authenticationCookie, measurementPlan, parseExistingLatencyConfig, privateText } from './config.ts'
import { assertDurableReceiptRequest, assertReadyRuntime, assertRenameReceipt, assertRequestTarget, correlatedRpcValue, distribution, failure, rpcValue, summarize } from './report.ts'

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const seed = () => ({ version: 1, origin: 'http://127.0.0.1:17799', platform: 'windows', release: 'frozen-test-release',
  authenticationFile: resolve('private-cookie'), outputFile: resolve('measurements.jsonl'), accountId: 7,
  nodeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', runtimeId: uuid, workspaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workspacePath: 'Q:\\QA\\work', computerName: 'QA Windows', language: 'zh', testModelLabel: 'Candidate QA', historySessionId: 'qa-history',
  historyTitle: 'QA_PERF_EXAMPLE history', historyMarker: 'QA_PERF_EXAMPLE marker', testPrefix: 'QA_PERF_EXAMPLE',
  browser: { engine: 'chromium' } })
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('existing deployment measurement plan', () => {
  it('requires exact QA coordinates and defaults to fifty separately counted operations', () => {
    const config = parseExistingLatencyConfig(seed())
    expect(config).toMatchObject({ samples: 50, intervalMs: 1000, timeoutMs: 30000 })
    const plan = measurementPlan(config)
    expect(plan).toMatchObject({
      execute: false, maximumNewSessions: 50, maximumPrompts: 50, explicitRuntimeStarts: false, startsServers: false,
    })
    expect(JSON.stringify(plan)).not.toContain('Q:\\QA')
    expect(JSON.stringify(plan)).not.toContain('private-cookie')
    expect(measurementArguments(['--config', config.authenticationFile]).execute).toBe(false)
    expect(() => measurementArguments(['--config', config.authenticationFile, '--execute', '--execute'])).toThrow()
  })

  it.each([
    { origin: 'https://harness.example.com' }, { origin: 'http://127.0.0.1:17799/path' },
    { origin: 'http://user:secret@127.0.0.1:17799' }, { runtimeId: '' }, { accountId: 0 },
    { samples: 0 }, { samples: 1001 }, { timeoutMs: Infinity }, { intervalMs: -1 },
    { testPrefix: 'ordinary-session' }, { historyTitle: 'unrelated history' }, { historyMarker: 'unrelated text' },
    { authenticationFile: 'relative-cookie' }, { fallbackRuntime: uuid }, { language: 'guess' },
    { browser: { engine: 'chromium', cdpEndpoint: 'https://public.example:9222' } },
    { browser: { engine: 'chromium', cdpEndpoint: 'https://127.0.0.1:9222' } },
    { browser: { engine: 'webkit', cdpEndpoint: 'http://127.0.0.1:9222' } },
  ])('rejects unsafe or ambiguous input %j', (patch) => { expect(() => parseExistingLatencyConfig({ ...seed(), ...patch })).toThrow() })

  it('accepts a dedicated tunneled Chromium but does not infer a remote browser from the target platform', () => {
    const config = parseExistingLatencyConfig({ ...seed(), browser: { engine: 'chromium', cdpEndpoint: 'http://127.0.0.1:19222' } })
    expect(config.browser.cdpEndpoint).toBe('http://127.0.0.1:19222')
    expect(parseExistingLatencyConfig(seed()).browser.cdpEndpoint).toBeUndefined()
  })

  it('does not serialize diagnostics containing business paths or credentials', () => {
    expect(failure(new Error('/private/path?token=secret'))).toEqual({ outcome: 'failed', error: 'measurement-failed' })
    expect(failure(Object.assign(new Error('sensitive'), { name: 'TimeoutError' })).outcome).toBe('timeout')
    expect(() => rpcValue({ result: { ok: false, error: { code: 'agent-preset-invalid', message: 'private path' } } })).toThrow('agent-preset-invalid')
    expect(() => rpcValue({ result: { ok: false, error: { code: 'file:/private/token', message: 'private path' } } })).toThrow('rpc-refused')
  })

  it('keeps only one opaque authentication cookie', () => {
    expect(authenticationCookie('qa_session=opaque==\n')).toEqual({ name: 'qa_session', value: 'opaque==' })
    for (const value of ['a=x; b=y', 'Bearer secret', 'a=', 'a=secret\r\nOther: leaked', 'a=secret\0data']) expect(() => authenticationCookie(value)).toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('POSIX private driver files', () => {
  it('runs the source CLI in plan mode with no credential file and no output mutation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-existing-cli-'))); roots.push(root)
    const file = join(root, 'config.json'), outputFile = join(root, 'output.jsonl')
    await writeFile(file, JSON.stringify({ ...seed(), authenticationFile: join(root, 'absent-cookie'), outputFile }), { mode: 0o600 })
    const result = await promisify(execFile)(process.execPath,
      ['--import', 'tsx/esm', resolve('scripts/measure-existing-deployment.ts'), '--config', file],
      { timeout: 10000, maxBuffer: 64 * 1024 })
    expect(JSON.parse(result.stdout)).toMatchObject({ execute: false, samplesPerOperation: 50, startsServers: false })
    expect(result.stderr).toBe('')
    await expect(readFile(outputFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prints the plan without reading the missing authentication file or loading execution', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-existing-plan-'))); roots.push(root)
    const file = join(root, 'config.json')
    await writeFile(file, JSON.stringify({ ...seed(), authenticationFile: join(root, 'not-present'), outputFile: join(root, 'output.jsonl') }), { mode: 0o600 })
    const execute = vi.fn(async () => ({ executed: true }))
    const fetchTripwire = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('planning must not contact an origin') })
    expect(await measureExistingDeployment(['--config', file], execute)).toMatchObject({ execute: false, samplesPerOperation: 50 })
    expect(execute).not.toHaveBeenCalled()
    expect(fetchTripwire).not.toHaveBeenCalled()
    await expect(readFile(join(root, 'output.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await measureExistingDeployment(['--config', file, '--execute'], execute)).toEqual({ executed: true })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects public, linked or relative private input', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-existing-private-'))); roots.push(root)
    const file = join(root, 'private'), linked = join(root, 'linked')
    await writeFile(file, 'qa_session=not-a-secret', { mode: 0o600 })
    await expect(privateText(file)).resolves.toBe('qa_session=not-a-secret')
    await symlink(file, linked)
    await expect(privateText(linked)).rejects.toThrow()
    await chmod(file, 0o644)
    await expect(privateText(file)).rejects.toThrow('private-file-required')
    await expect(privateText('relative')).rejects.toThrow('absolute-local-path-required')
  })
})

describe('exact workload and statistics', () => {
  it('accepts a correlated ordinary rename receipt and rejects the wrong title, RPC or event sequence', () => {
    const title = 'QA_PERF_EXAMPLE_1'
    const response = { rpcId: 'rename-1', result: { ok: true, value: { title, seq: 2 } } }
    expect(() =>{  assertRenameReceipt(response, 'rename-1', title) }).not.toThrow()
    expect(() =>{  assertRenameReceipt(response, 'another-rpc', title) }).toThrow('rpc-receipt-mismatch')
    expect(() =>{  assertRenameReceipt(response, 'rename-1', 'wrong-title') }).toThrow('test-session-naming-receipt-mismatch')
    for (const seq of [-1, .5, '2', null]) {
      expect(() =>{  assertRenameReceipt({ ...response, result: { ok: true, value: { title, seq } } }, 'rename-1', title) })
        .toThrow('test-session-naming-receipt-mismatch')
    }
  })

  it('rejects ordinary ACKs and mismatched application or transport identities as durable receipts', () => {
    const request = { rpcId: 'rpc-1', method: 'session.prompt', payload: { sessionId: 'qa-session', requestId: 'input-1' } }
    const response = { rpcId: 'rpc-1', result: { ok: true, value: { accepted: true } } }
    expect(correlatedRpcValue(response, request)).toEqual({ accepted: true })
    expect(() => correlatedRpcValue({ ...response, rpcId: 'rpc-other' }, request)).toThrow('rpc-receipt-mismatch')
    expect(assertDurableReceiptRequest('http://localhost:17799/api/admit/v1/session.prompt', request, 'qa-session', 'input-1')).toBe('prompt')
    const status = { ...request, method: 'session.promptStatus' }
    expect(assertDurableReceiptRequest('http://localhost:17799/api/admit/v1/session.status', status, 'qa-session', 'input-1')).toBe('status')
    for (const [url, body, session, input] of [
      ['/api/session.prompt', request, 'qa-session', 'input-1'],
      ['/api/admit/v1/session.prompt', request, 'another-session', 'input-1'],
      ['/api/admit/v1/session.status', status, 'qa-session', 'another-input'],
      ['/api/admit/v1/session.status', request, 'qa-session', 'input-1'],
    ] as const) expect(() => assertDurableReceiptRequest(`http://localhost:17799${url}`, body, session, input)).toThrow('durable-receipt-request-mismatch')
  })

  it('rejects another owner, node, sleeping Runtime and ambiguous requests before mutation', () => {
    const config = parseExistingLatencyConfig(seed())
    const item = { id: config.runtimeId, owner: { kind: 'personal', id: config.accountId },
      node: { id: config.nodeId, name: config.computerName, status: 'active' }, observedState: 'ready' }
    expect(() =>{  assertReadyRuntime({ items: [item] }, config) }).not.toThrow()
    for (const patch of [{ observedState: 'stopped' }, { owner: { kind: 'personal', id: 8 } },
      { node: { ...item.node, id: uuid } }, { node: { ...item.node, status: 'offline' } }]) {
      expect(() =>{  assertReadyRuntime({ items: [{ ...item, ...patch }] }, config) }).toThrow()
    }
    const url = new URL('/api/prepare/v1/session.create', config.origin)
    url.search = new URLSearchParams({ dshRuntime: config.runtimeId, dshNode: config.nodeId, dshTarget: 'personal' }).toString()
    expect(() =>{  assertRequestTarget(url.href, '7', config) }).not.toThrow()
    expect(() =>{  assertRequestTarget(url.href, '8', config) }).toThrow('request-target-mismatch')
    url.searchParams.delete('dshNode')
    expect(() =>{  assertRequestTarget(url.href, '7', config) }).not.toThrow()
    url.searchParams.set('dshNode', config.nodeId)
    url.searchParams.append('dshNode', config.nodeId)
    expect(() =>{  assertRequestTarget(url.href, '7', config) }).toThrow('request-target-mismatch')
    url.searchParams.set('dshNode', uuid)
    expect(() =>{  assertRequestTarget(url.href, '7', config) }).toThrow('request-target-mismatch')
  })

  it('does not turn failed or unattempted work into fast samples', () => {
    const report = summarize([
      { index: 1, operation: 'hot-create', outcome: 'ok', readyMs: 10, editableMs: 2 },
      { index: 2, operation: 'hot-create', outcome: 'timeout', editableMs: 3 },
      { index: 1, operation: 'hot-open', outcome: 'failed', error: 'permission-denied' },
      { index: 1, operation: 'durable-send', outcome: 'ok', durableReceiptMs: 20, driverMs: 1200, firstVisibleAnswerMs: 2500 },
    ], 50)
    expect(report['hot-create']).toMatchObject({ attempted: 2, successful: 1, failed: 1, timeout: 1, notRun: 48, failureRate: .5,
      metrics: { ready: { samples: 1, p50Ms: 10, p95Ms: 10 } } })
    expect(report['hot-open']).toMatchObject({ metrics: { ready: { samples: 0, p50Ms: null, p95Ms: null } } })
    expect(report['durable-send']).toMatchObject({ metrics: { durableReceipt: { p95Ms: 20 }, driver: { p95Ms: 1200 }, firstVisibleAnswer: { p95Ms: 2500 } } })
    expect(distribution(Array.from({ length: 50 }, (_, index) => index + 1))).toEqual({ samples: 50, p50Ms: 25, p95Ms: 48 })
  })
})
