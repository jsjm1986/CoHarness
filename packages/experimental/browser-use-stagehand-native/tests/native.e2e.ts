/** Opt-in installed Stagehand smoke against an owned local page and optional real model. */

import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Provider from '../src/index.ts'
import { stagehandModelSchema } from '../src/native.ts'
import { launchChromium } from '../src/launch.ts'
import { nativeModel } from './fixtures/stagehand.ts'

async function mountAttachments(ctx: Context): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stagehand-model-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
}

class ImageCapabilities extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('Unexpected model call in browser smoke') }
}

for (const reuseExtension of [false, true]) {
  const scenario = `preserves external Chromium across source/built connections (reuse extension: ${reuseExtension})`
  it.skipIf(process.env.DSH_STAGEHAND_E2E !== '1')(scenario, { timeout: 120_000, retry: 0 }, async ({ signal }) => {
    const started = performance.now()
    const stages: Array<{ stage: string; elapsedMs: number }> = []
    const stage = (name: string): void => { stages.push({ stage: name, elapsedMs: Math.round(performance.now() - started) }) }
    onTestFailed(() => { console.error('Stagehand source/built milestones:', JSON.stringify(stages)) })
    const executable = process.env.DSH_BROWSER_EXECUTABLE
    if (executable === undefined) throw new Error('DSH_STAGEHAND_E2E requires DSH_BROWSER_EXECUTABLE')
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>Stagehand fixture</title><h1>Stagehand local smoke</h1><button onclick="this.textContent=\'Clicked\'">Click fixture</button>')
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-stagehand-live-'))
    const ctx = new Context()
    let external: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing fixture server address')
      const url = `http://127.0.0.1:${address.port}/`
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(BrowserUseRegistry)
      await ctx.plugin(LocalAttachmentStore, { dshHome: root })
      ctx.llm.registerAdapter(['visual-fixture'], new ImageCapabilities())
      const harness = await mountAgentLoopTestHarness(ctx)
      const agent = await harness.create(SessionId('stagehand-live'), { provider: 'visual-fixture', model: 'vision' })
      const execute = (suffix: string, args: unknown) => ctx.tools.execute({
        agent, name: `stagehand_${suffix}`, arguments: args, callId: ToolCallId(`live-${suffix}`), signal,
      })
      const launched = ctx.plugin(Provider, { model: nativeModel, mode: 'launch', executablePath: executable })
      await launched
      stage('owned-navigation')
      const navigation = await execute('navigate', { url })
      expect(navigation.isError, JSON.stringify(navigation.content)).toBe(false)
      expect(JSON.stringify(navigation.content)).toContain('Stagehand fixture')
      const screenshot = await execute('screenshot', {})
      expect(screenshot.isError, JSON.stringify(screenshot.content)).toBe(false)
      expect(screenshot.content.some(block => block.type === 'image')).toBe(true)
      stage('owned-disposal')
      await launched.dispose()

      stage('external-launch')
      external = spawn(executable, [
        '--headless=new', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--remote-allow-origins=*',
        `--user-data-dir=${join(root, 'external-profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      exited = once(external, 'exit')
      const endpoint = await new Promise<string>((resolve, reject) => {
        let stderr = ''
        external!.stderr!.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
          const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr)
          if (match?.[1] !== undefined) resolve(match[1])
        })
        external!.once('error', reject)
        external!.once('exit', (code) => { reject(new Error(`External Chrome exited before readiness (${code}): ${stderr}`)) })
      })
      const attached = ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: endpoint })
      await attached
      stage('source-attachment')
      const attachedNavigation = await execute('navigate', { url })
      expect(attachedNavigation.isError, JSON.stringify(attachedNavigation.content)).toBe(false)
      const createdUrl = `${url}created-by-tool`
      const created = await execute('tabs', { action: 'new', url: createdUrl })
      expect(created.isError, JSON.stringify(created.content)).toBe(false)
      stage('source-disposal')
      await attached.dispose()
      expect(external.exitCode).toBeNull()
      const versionUrl = new URL(endpoint)
      versionUrl.protocol = 'http:'
      versionUrl.pathname = '/json/list'
      const targets = await (await fetch(versionUrl, { signal })).json() as Array<{ url: string }>
      expect(targets.some(target => target.url === url)).toBe(true)
      expect(targets.some(target => target.url === createdUrl)).toBe(true)
      const workers = targets.filter(target => target.url.startsWith('chrome-extension://') && target.url.endsWith('/service-worker.js'))
      expect(workers).toHaveLength(1)
      const extensionId = new URL(workers[0]!.url).hostname
      stage('built-reattachment')
      const { stdout } = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL('./fixtures/built-attachment.mjs', import.meta.url)), endpoint, `${url}built-worker`,
        ...reuseExtension ? [extensionId] : [],
      ], { signal, env: {} })
      expect(stdout).toContain('Stagehand fixture')
      expect(JSON.parse(stdout)).toMatchObject({ admissions: 1, completions: 1, waited: true })
      expect(external.exitCode).toBeNull()
      const afterBuilt = await (await fetch(versionUrl, { signal })).json() as Array<{ url: string }>
      expect(afterBuilt.some(target => target.url === `${url}built-worker`)).toBe(true)
      stage('built-completed')
    } finally {
      stage('cleanup')
      await ctx.fiber.dispose()
      if (external !== undefined && external.exitCode === null) external.kill('SIGTERM')
      await exited
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
      await rm(root, { recursive: true, force: true })
    }
  })
}

it.skipIf(process.env.DSH_STAGEHAND_E2E !== '1')('admits the built attachment Worker under plain Node without closing its external Chromium', { timeout: 120_000, retry: 0 }, async ({ signal }) => {
  const executable = process.env.DSH_BROWSER_EXECUTABLE
  if (executable === undefined) throw new Error('DSH_STAGEHAND_E2E requires DSH_BROWSER_EXECUTABLE')
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>Stagehand fixture</title><h1>Built Worker admission</h1>')
  })
  let browser: Awaited<ReturnType<typeof launchChromium>> | undefined
  const launchContext = new Context()
  try {
    await launchContext.plugin(LocalSubprocessRuntime)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing built fixture server address')
    const url = `http://127.0.0.1:${address.port}/built-worker`
    const owned = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./fixtures/built-attachment.mjs', import.meta.url)), '--launch', executable, url,
    ], { signal, env: {} })
    expect(owned.stdout).toContain('Stagehand fixture')
    expect(JSON.parse(owned.stdout)).toMatchObject({ admissions: 2, completions: 2, waited: true })
    browser = await launchChromium({ executablePath: executable,
      headless: true, operationTimeoutMs: 30_000, processGraceMs: 2000, processCloseTimeoutMs: 5000 },
    signal, launchContext.subprocess, SessionId('external-browser-fixture'))
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./fixtures/built-attachment.mjs', import.meta.url)), browser.endpoint, url,
    ], { signal, env: {} })
    expect(stdout).toContain('Stagehand fixture')
    expect(JSON.parse(stdout)).toMatchObject({ admissions: 1, completions: 1, waited: true })
    const targets = new URL(browser.endpoint)
    targets.protocol = 'http:'
    targets.pathname = '/json/list'
    const pages = await (await fetch(targets, { signal })).json() as Array<{ url: string }>
    expect(pages.some(page => page.url === url)).toBe(true)
  } finally {
    try { await browser?.close(); await launchContext.fiber.dispose() } finally {
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    }
  }
})

it.skipIf(process.env.DSH_STAGEHAND_E2E !== '1' || !process.env.DSH_STAGEHAND_PROVIDER || !process.env.DSH_STAGEHAND_MODEL || !process.env.DSH_STAGEHAND_MODEL_API_KEY)('extracts a controlled heading using an independently configured host model', { timeout: 120_000, retry: 0 }, async ({ signal }) => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><h1>Stagehand structured result</h1>')
  })
  const ctx = new Context()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
    await mountAgentLoopTestDependencies(ctx)
    await mountAttachments(ctx)
    await ctx.plugin(BrowserUseRegistry)
    const model = stagehandModelSchema.parse({ provider: process.env.DSH_STAGEHAND_PROVIDER, model: process.env.DSH_STAGEHAND_MODEL })
    const provider = await import('@deepseek-ai/dsh-llm-pi-ai')
    await ctx.plugin(provider, { providers: { [model.provider]: { apiKeyEnv: 'DSH_STAGEHAND_MODEL_API_KEY' } } })
    await ctx.plugin(Provider, { model, mode: 'launch', ...process.env.DSH_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DSH_BROWSER_EXECUTABLE } })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('stagehand-real-model'), {})
    const execute = (suffix: string, args: unknown) => ctx.tools.execute({ agent, name: `stagehand_${suffix}`, arguments: args, callId: ToolCallId(`api-${suffix}`), signal })
    const navigation = await execute('navigate', { url: `http://127.0.0.1:${address.port}` })
    expect(navigation.isError, JSON.stringify(navigation.content)).toBe(false)
    const result = await execute('extract', {
      instruction: 'Extract the exact h1 heading.',
      schema: { type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'], additionalProperties: false },
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Stagehand structured result')
    expect(agent.session.snapshotEvents().some(event => event.type === 'browser-use/stagehand-llm-request')).toBe(true)
  } finally {
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
})


// The executable wrapper uses a POSIX shebang; the ordinary browser smoke runs on every platform.
it.skipIf(process.env.DSH_STAGEHAND_E2E !== '1' || process.platform === 'win32')('scrubs real Chromium environment and closes it during canceled Stagehand initialization', { timeout: 120_000, retry: 0 }, async () => {
  const executable = process.env.DSH_BROWSER_EXECUTABLE
  if (executable === undefined) throw new Error('DSH_STAGEHAND_E2E requires DSH_BROWSER_EXECUTABLE')
  const root = await mkdtemp(join(tmpdir(), 'dsh-stagehand-acquire-'))
  const marker = join(root, 'browser.json')
  const wrapper = join(root, 'chrome.mjs')
  const sockets = new Set<import('node:stream').Duplex>()
  const connected: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const stalled = createServer()
  stalled.on('upgrade', (_request, socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    connected.resolve(undefined)
  })
  const ctx = new Context()
  vi.stubEnv('BROWSER_FIXTURE_API_TOKEN', 'do-not-forward')
  vi.stubEnv('DSH_BROWSER_FIXTURE_ID', 'do-not-forward')
  vi.stubEnv('BROWSER_FIXTURE_PUBLIC', 'visible')
  try {
    stalled.listen(0, '127.0.0.1')
    await once(stalled, 'listening')
    const address = stalled.address()
    if (address === null || typeof address === 'string') throw new Error('No stalled CDP listener')
    const endpoint = `ws://127.0.0.1:${address.port}/devtools/browser/stalled`
    await writeFile(wrapper, [
      `#!${process.execPath}`,
      'import { spawn } from \'node:child_process\'',
      'import { writeFileSync } from \'node:fs\'',
      `const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: ['ignore', 'ignore', 'pipe'], env: process.env })`,
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: child.pid, token: process.env.BROWSER_FIXTURE_API_TOKEN ?? null, identity: process.env.DSH_BROWSER_FIXTURE_ID ?? null, publicValue: process.env.BROWSER_FIXTURE_PUBLIC, profile: process.argv.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length) }))`,
      'let output = \'\'',
      `child.stderr.on('data', chunk => { output += chunk.toString(); if (output.includes('DevTools listening on ')) { process.stderr.write(${JSON.stringify(`DevTools listening on ${endpoint}\n`)}); output = '' } })`,
      'child.on(\'error\', error => { console.error(error); process.exit(1) })',
      'child.on(\'exit\', code => process.exit(code ?? 1))',
      '',
    ].join('\n'))
    await chmod(wrapper, 0o700)
    await mountAgentLoopTestDependencies(ctx)
    await mountAttachments(ctx)
    await ctx.plugin(BrowserUseRegistry)
    await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(Provider, { model: nativeModel, mode: 'launch', executablePath: wrapper })
    const owner = await ctx.agents.create({ sessionId: SessionId('stagehand-stalled-init') })
    const operation = owner.agent.runMaintenance(signal => ctx.tools.execute({
      agent: owner.agent, name: 'stagehand_tabs', arguments: { action: 'list' }, callId: ToolCallId('stalled-init'), signal,
    }))
    await connected.promise
    const browser = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; token: unknown; identity: unknown; publicValue: string; profile: string }
    expect(browser.token).toBeNull()
    expect(browser.identity).toBeNull()
    expect(browser.publicValue).toBe('visible')
    expect(() => process.kill(browser.pid, 0)).not.toThrow()
    await owner.dispose()
    expect((await operation).isError).toBe(true)
    await vi.waitFor(() => { expect(() => process.kill(browser.pid, 0)).toThrow() })
    await expect(access(browser.profile)).rejects.toThrow()
  } finally {
    for (const socket of sockets) socket.destroy()
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => { stalled.close((error) => { if (error) reject(error); else resolve() }) })
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.env.DSH_STAGEHAND_E2E !== '1')('drains canceled navigation before reconnecting to the same Chromium tabs', { timeout: 120_000, retry: 0 }, async () => {
  const executable = process.env.DSH_BROWSER_EXECUTABLE
  if (executable === undefined) throw new Error('DSH_STAGEHAND_E2E requires DSH_BROWSER_EXECUTABLE')
  const entered: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const release: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const server = createServer((request, response) => {
    const send = () => {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>Retained browser</title><h1>Keep this page</h1>')
    }
    if (request.url === '/pending') {
      entered.resolve(undefined)
      void release.promise.then(send)
    } else send()
  })
  const ctx = new Context()
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('No cancellation fixture listener')
    const url = `http://127.0.0.1:${address.port}/pending`
    await mountAgentLoopTestDependencies(ctx)
    await mountAttachments(ctx)
    await ctx.plugin(BrowserUseRegistry)
    await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(Provider, { model: nativeModel, mode: 'launch', executablePath: executable })
    const owner = await ctx.agents.create({ sessionId: SessionId('stagehand-cancel-reconnect') })
    const call = (method: string, args: unknown) => owner.agent.runMaintenance(signal => ctx.tools.execute({
      agent: owner.agent, name: `stagehand_${method}`, arguments: args, callId: ToolCallId(`reconnect-${method}`), signal,
    }))
    expect((await call('navigate', { url: url.replace('/pending', '/retained') })).isError).toBe(false)
    const navigation = call('navigate', { url })
    await entered.promise
    owner.agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    expect((await navigation).isError).toBe(true)
    const tabs = await call('tabs', { action: 'list' })
    expect(tabs.isError, JSON.stringify(tabs.content)).toBe(false)
    expect(JSON.stringify(tabs.content)).toContain(url)
    expect(JSON.stringify(tabs.content)).toContain('Retained browser')
    await owner.dispose()
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
})
