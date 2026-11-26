/** Standalone browser regression for directory discovery; no deployment, credentials or server is used. */
import assert from 'node:assert/strict'
import { computerBrowser } from '../../apps/web/tests/computer-browser.ts'
import { revealHistoryRow, waitForInitialDirectory } from './runner.ts'
import { clientSessionKey, type ClientRuntimeId } from '../../packages/host/apiproxy/src/api/client-session.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const browser = await computerBrowser()
try {
  const context = await browser.newContext()
  try {
    await context.addInitScript({ content: 'Object.defineProperty(globalThis, "__name", { configurable: true, value: (fn, name) => Object.defineProperty(fn, "name", { value: name, configurable: true }) });' })
    const page = await context.newPage()
    const target = { computerName: 'Windows QA', workspaceId: 'qa-workspace', timeoutMs: 5_000 }
    await page.setContent('<section aria-label="Windows QA"><button aria-expanded="false">Windows QA</button></section>')
    assert.equal(await page.evaluate(({ computerName, workspaceId }) => [...document.querySelectorAll('[role="region"]')]
      .some(row => row.getAttribute('aria-label') === computerName)
      || [...document.querySelectorAll<HTMLElement>('[data-row-key]')].some(row => row.dataset.rowKey === `workspace:${workspaceId}`), target), false,
    'the former selector must miss the collapsed implicit region')
    await waitForInitialDirectory(page, target)
    assert.equal(await page.getByRole('button', { name: target.computerName, exact: true }).getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('[data-row-key]').count(), 0, 'discovery must not require workspace rows')

    await page.setContent('<div role="region" aria-label="Windows QA">Directory</div>')
    await waitForInitialDirectory(page, target)

    await page.setContent('<section aria-labelledby="computer-name"><h2 id="computer-name">Windows QA</h2></section>')
    await waitForInitialDirectory(page, target)

    await page.setContent('<button data-row-key="workspace:qa-workspace">Personal workspace</button>')
    await waitForInitialDirectory(page, target)

    for (const markup of [
      '<section aria-label="Windows QA extra">Another computer</section>',
      '<button data-row-key="workspace:another-workspace">Another workspace</button>',
      '<section aria-label="Windows QA" hidden>Hidden directory</section>',
    ]) {
      await page.setContent(markup)
      await assert.rejects(waitForInitialDirectory(page, { ...target, timeoutMs: 100 }), { name: 'TimeoutError' })
    }
    const history = { ...target, runtimeId: 'qa-runtime', historySessionId: 'qa-seed', historyTitle: 'QA_PERF_HISTORY', language: 'en' as const }
    const historyKey = `session:${clientSessionKey({ kind: 'personal', runtimeId: history.runtimeId as ClientRuntimeId }, history.historySessionId as SessionId)}`
    for (const paged of [false, true]) {
      await page.setContent(`<style>[role="tree"]{height:180px;overflow:auto} [data-row-key]{display:block;height:30px;box-sizing:border-box} [hidden]{display:none!important}</style>
        <section aria-label="Windows QA"><div>
          <div><button id="other-runtime-more">More workspaces and conversations</button></div>
          <div id="directory"><div><div role="tree">
            <div><div data-row-key="workspace:qa-workspace" aria-expanded="true">Workspace</div>
              <div id="rows"></div><button id="overflow" data-row-key="overflow:qa-workspace" aria-expanded="false">Show more sessions</button>
            </div>
            <div><button id="other-workspace" data-row-key="overflow:other-workspace" aria-expanded="false">Show more sessions</button></div>
          </div></div><button id="more">More workspaces and conversations</button></div>
        </div></section>`)
      await page.evaluate(({ historyKey, title, paged }) => {
        const state = window as Window & { __historyCheck?: { opens: number; wrong: number; expanded: number; pages: number } }
        const check = state.__historyCheck = { opens: 0, wrong: 0, expanded: 0, pages: 0 }
        const getElement = (id: string): HTMLElement => {
          const element = document.getElementById(id)
          if (element === null) throw new Error(`Missing browser fixture: ${id}`)
          return element
        }
        const rows = getElement('rows'), overflow = getElement('overflow'), more = getElement('more')
        const tree = rows.closest('[role="tree"]')
        if (tree === null) throw new Error('Missing history tree fixture')
        let shown = 0
        const appendRows = (count: number) => {
          for (let i = 0; i < count; i++) {
            const row = document.createElement('button')
            shown++
            row.setAttribute('data-row-key', shown === 35 ? historyKey : `session:recent-${shown}`)
            row.textContent = shown === 35 ? title : `Recent ${shown}`
            row.addEventListener('click', () => { check.opens++ })
            rows.append(row)
          }
          overflow.setAttribute('aria-expanded', String(shown >= 35))
          overflow.textContent = shown >= 35 ? 'Show less' : `Show ${35 - shown} more sessions`
        }
        overflow.addEventListener('click', () => { check.expanded++; appendRows(Math.min(5, 35 - shown)) })
        more.addEventListener('click', () => { check.pages++; appendRows(5); more.remove(); overflow.hidden = false })
        for (const id of ['other-runtime-more', 'other-workspace']) getElement(id).addEventListener('click', () => { check.wrong++ })
        appendRows(14)
        if (paged) overflow.hidden = true
        else more.remove()
        tree.scrollTop = 0
      }, { historyKey, title: history.historyTitle, paged })
      const old = page.locator(`[data-row-key=${JSON.stringify(historyKey)}]`)
      await assert.rejects(old.click({ timeout: 100 }), { name: 'TimeoutError' }, 'the former direct click cannot reveal a missing history row')
      const located = await revealHistoryRow(page, history)
      assert.equal(await located.getAttribute('data-row-key'), historyKey)
      const result = await located.evaluate((el) => {
        const tree = el.closest('[role="tree"]')
        if (tree === null) throw new Error('Restored history is outside the tree')
        return {
          check: (window as Window & { __historyCheck?: object }).__historyCheck,
          scrollTop: tree.scrollTop, visible: el.getBoundingClientRect().top >= tree.getBoundingClientRect().top,
        }
      })
      assert.ok(result.scrollTop > 0, 'history must be scrolled into the tree viewport')
      assert.equal(result.visible, true)
      assert.deepEqual(result.check, { opens: 0, wrong: 0, expanded: paged ? 4 : 5, pages: paged ? 1 : 0 })
      await located.click()
      assert.equal(await page.evaluate(() => (window as Window & { __historyCheck?: { opens: number } }).__historyCheck?.opens), 1)
    }
    await page.setContent('<div><div><div role="tree"><div data-row-key="workspace:qa-workspace" aria-expanded="true">Workspace</div><button data-row-key="overflow:qa-workspace" aria-expanded="false">Show more sessions</button></div></div></div>')
    await assert.rejects(revealHistoryRow(page, { ...history, timeoutMs: 100 }), /timeout/iu, 'a stalled control must fail without repeated clicks or a fresh deadline')
    console.info(JSON.stringify({ ok: true, cases: 10, legacySelectorNegativeControl: true, legacyHistoryClickNegativeControl: true }))
  } finally { await context.close() }
} finally { await browser.close() }
