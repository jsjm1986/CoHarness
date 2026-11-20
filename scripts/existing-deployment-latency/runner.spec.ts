/** Fail-closed execution setup using an in-memory directory response; no network or browser is opened. */
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExistingLatencyConfig } from './config.ts'

const launched = vi.hoisted(() => vi.fn(() => { throw new Error('This offline case must not open a browser') }))
vi.mock('../../apps/web/tests/computer-browser.ts', () => ({ launchComputerBrowser: launched }))
import { measureDeployment, renameTestSession } from './runner.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  launched.mockClear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
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
