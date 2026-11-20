/** Owned App browser fixture shared by organization and exact-local governance recovery. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import type { GovernanceRebuildGateway } from '../src/governance-rebuild-gateway.ts'

/** Start an isolated browser and HTTP dispatcher with the actual Admin application.
 * @param input - database-owned recovery dispatcher and private fixture root.
 * @returns page, observed requests and joined cleanup; no Runtime is started.
 */
export async function governanceRecoveryUiFixture(input: {gateway: GovernanceRebuildGateway; adminId: number; root: string; local?: boolean}) {
  const [{ chromium }, { build }] = await Promise.all([import('../../apps/web/tests/peer-backup-browser.ts'), import('vite')])
  const directory = join(input.root, 'governance-review-ui'), admin = resolve(import.meta.dirname, '../admin-ui')
  await mkdir(directory, { recursive: true })
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `import React from ${JSON.stringify(join(admin, 'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(join(admin, 'node_modules/react-dom/client.js'))};
import {App} from ${JSON.stringify(join(admin, 'src/App.tsx'))};
import ${JSON.stringify(join(admin, 'src/index.css'))};
createRoot(document.getElementById('root')).render(React.createElement(App));`)
  await build({ configFile: join(admin, 'vite.config.ts'), root: admin, logLevel: 'error', define: { 'process.env.NODE_ENV': '"development"' }, build: {
    outDir: join(directory, 'assets'), emptyOutDir: true, minify: false,
    lib: { entry, formats: ['es'], fileName: () => 'fixture.js', cssFileName: 'fixture' },
  } })
  const assets = new Set(await readdir(join(directory, 'assets'))), cookie = 'fixture=' + randomUUID()
  const failures: unknown[] = [], calls: Array<{ method: string; path: string; status: number }> = []
  const lifetime = new AbortController()
  const server = createServer((req, res) => { void (async () => {
    if (!(req.headers.cookie ?? '').split('; ').includes(cookie)) { res.writeHead(401).end(); return }
    const path = new URL(req.url!, 'http://fixture.test').pathname
    if (path.startsWith('/admin/api/')) {
      res.once('finish', () => calls.push({ method: req.method!, path, status: res.statusCode }))
      if (!await input.gateway.admin(req, res, input.adminId, { directLocal: true, signal: lifetime.signal })) res.writeHead(404).end()
    } else if (path === '/admin/governance-recovery' || path === '/admin/governance-recovery/local') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/assets/fixture.css"><body><div id="root"></div><script type="module" src="/admin/assets/fixture.js"></script></body></html>')
    } else if (path.startsWith('/admin/assets/') && assets.has(path.slice('/admin/assets/'.length))) {
      res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'application/javascript')
      res.end(await readFile(join(directory, 'assets', path.slice('/admin/assets/'.length))))
    } else res.writeHead(404).end()
  })().catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end() }) })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('UI fixture did not listen')
    const origin = 'http://127.0.0.1:' + address.port
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: input.local ? { width: 390, height: 844 } : { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' })
    await context.addCookies([{ name: 'fixture', value: cookie.slice(8), url: origin }, { name: 'hgw_lang', value: 'en', url: origin }])
    await context.addInitScript(() => localStorage.setItem('coharness-admin-language', 'en'))
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => failures.push(error))
    const capture = async (stage: string, mobile: boolean, transcript: string) => {
      const golden = resolve(import.meta.dirname, 'snapshots/governance-rebuild-review', stage + '.expected.json')
      if (process.env.DSH_SNAPSHOT === 'refresh') { await mkdir(resolve(golden, '..'), { recursive: true }); await writeFile(golden, transcript) }
      expect(transcript).toBe(await readFile(golden, 'utf8'))
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.locator('button, summary').evaluateAll((buttons, touch) => buttons.filter(button => {
        const r = button.getBoundingClientRect(); if (!r.width && !r.height) return false
        return r.left < 0 || r.right > innerWidth || touch && r.height < 44 || button.scrollWidth > button.clientWidth + 1
      }).map(button => button.textContent), mobile)).toEqual([])
      if (process.env.HGW_TEST_UI_ARTIFACTS) {
        await mkdir(process.env.HGW_TEST_UI_ARTIFACTS, { recursive: true })
        await page.screenshot({ path: join(process.env.HGW_TEST_UI_ARTIFACTS, 'governance-' + stage + '.png'), fullPage: true })
        await writeFile(join(process.env.HGW_TEST_UI_ARTIFACTS, 'governance-' + stage + '.json'), transcript)
      }
    }
    const close = async () => {
      lifetime.abort(); await browser?.close(); server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    }
    return { page, context, origin, calls, failures, capture, close }
  } catch (error) {
    lifetime.abort(); await browser?.close(); server.closeAllConnections()
    if (server.listening) await new Promise<void>((done, reject) => server.close(cause => cause ? reject(cause) : done()))
    throw error
  }
}
