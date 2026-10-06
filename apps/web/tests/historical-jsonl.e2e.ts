/** Cold legacy JSONL restoration through the shipped Host and browser history path. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./snapshots/historical-jsonl/message.expected.md', import.meta.url))

it.each([2, 3])('opens persisted CoHarness v%s history without rewriting its original generation', async (version) => {
  const scaffold = await launchWebScaffold()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const id = SessionId(`historical-jsonl-v${version}`)
    const cwd = scaffold.workspaceCwd
    const rows: Array<Record<string, unknown>> = []
    const append = (type: string, data: unknown, fields: Record<string, unknown> = {}) => {
      rows.push({ type, seq: rows.length, time: 1_789_000_000_000 + rows.length, data, ...fields })
    }
    append('turn/start', { turn: 1 })
    append('step/start', { turn: 1, step: 1 })
    if (version === 3) append('system/message', { turn: 1, step: 1,
      message: { id: 'old-system', role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [] },
    }, { surfaceOp: 'append' })
    append('user/message', { id: 'old-question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Recover this historical conversation.' }] }, { surfaceOp: 'append' })
    append('assistant/message', { turn: 1, step: 1, message: { id: 'old-answer', role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Historical answer preserved.' }],
    } }, { surfaceOp: 'append' })
    append('step/end', { turn: 1, step: 1 })
    append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const sourcePath = generationLogPath(scaffold.persistenceRoot, cwd, id, version, 'zstd')
    const source = Buffer.concat(await Promise.all([
      compressZstdFrame(JSON.stringify({
        type: 'session', version, id, createdAt: 1_789_000_000_000, cwd, delegationDepth: 0,
        // `isSeeded` entered the physical header at v3 and is absent at v2.
        ...(version >= 3 ? { isSeeded: false } : {}),
      }) + '\n'),
      compressZstdFrame(rows.map(row => JSON.stringify(row)).join('\n') + '\n'),
    ]))
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, source, { flag: 'wx' })
    const response = await scaffold.hostFetch('/api/session.history', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'historical-read', method: 'session.history', payload: { sessionId: id, maxMessages: 20 } }),
    })
    expect(response.status).toBe(200)
    const history = await response.json() as { result: { ok: boolean; value: unknown } }
    expect(history.result.ok, JSON.stringify(history)).toBe(true)
    expect(JSON.stringify(history.result.value)).toContain('Historical answer preserved.')
    expect(scaffold.ctx.agents.get(id)).toBeUndefined()

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 }); await group.click()
    const session = page.locator('[role="treeitem"]').nth(1)
    await session.waitFor({ timeout: 15_000 }); await session.click()
    const answer = page.getByText('Historical answer preserved.', { exact: true })
    await answer.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(EXPECTED, await answer.ariaSnapshot(), webSnapshotMode())
    expect(await readFile(sourcePath)).toEqual(source)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
