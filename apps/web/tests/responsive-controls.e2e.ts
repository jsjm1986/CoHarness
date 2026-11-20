/** Pure HTML witnesses for control reachability without programmatically revealing clipped content. */
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { expectViewportFit, responsiveBrowser } from './responsive-browser.ts'
import { auditResponsiveControl, auditResponsiveControls } from './responsive-controls.ts'

let browser: Browser
beforeAll(async () => { browser = await responsiveBrowser.launch() })
afterAll(async () => { await browser?.close() })

const cases = (['horizontal', 'vertical'] as const).flatMap(axis =>
  (['hidden', 'auto'] as const).map(overflow => ({ axis, overflow })))

const interactiveSurfaces = [
  '<button class="control">Open</button>',
  '<a class="control" href="#target">Open</a>',
  '<details><summary class="control">Open</summary></details>',
  '<div class="control" role="button" tabindex="0">Open</div>',
]

it.each(interactiveSurfaces.flatMap(html => (['hidden', 'auto'] as const).map(overflow => ({ html, overflow }))))(
  'checks an interactive surface itself in overflow $overflow: $html', async ({ html, overflow }) => {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    try {
      await page.setContent(`<style>
        body { margin:0; } section { width:200px; height:100px; overflow:${overflow}; }
        .control { display:block; box-sizing:border-box; width:140px; height:44px; margin-top:180px; }
      </style><section>${html}</section>`)
      const check = auditResponsiveControls(page, page.locator('.control'), 'interactive-surface')
      if (overflow === 'hidden') await expect(check).rejects.toThrow('non-scrollable hidden or clip ancestor')
      else await check
    } finally { await page.close() }
  },
)

it('rejects an interactive surface fixed below the viewport', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent('<button style="position:fixed;top:260px;width:140px;height:44px">Open</button>')
    await expect(auditResponsiveControls(page, page.getByRole('button'), 'fixed-surface')).rejects.toThrow('reachable control')
  } finally { await page.close() }
})

it('reveals a control through a scrollport inside a clipped shell without moving the shell', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<section style="height:100px;overflow:hidden"><div style="height:100px;overflow:auto">
      <button style="width:140px;height:44px;margin-top:180px">Open</button></div></section>`)
    await auditResponsiveControl(page, page.getByRole('button', { name: 'Open' }), 'nested-scrollport')
    expect(await page.locator('section').evaluate(node => node.scrollTop)).toBe(0)
    expect(await page.locator('section > div').evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  } finally { await page.close() }
})

it.each(cases)('checks $axis reachability inside overflow $overflow', async ({ axis, overflow }) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>
      body { margin: 0; }
      section { width: 200px; height: 100px; overflow: ${overflow}; border: 1px solid; }
      button { width: 140px; height: 44px; ${axis === 'horizontal' ? 'margin-left: 220px;' : 'margin-top: 180px;'} }
    </style><section><button>Save draft</button></section>`)
    const check = auditResponsiveControls(page, page.locator('section'), `${axis}/${overflow}`)
    if (overflow === 'hidden') await expect(check).rejects.toThrow('non-scrollable hidden or clip ancestor')
    else await check
  } finally { await page.close() }
})

it('keeps native modal controls reachable outside their document clipping ancestors', async () => {
  const page: Page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>
      section { width: 20px; height: 20px; overflow: hidden; }
      dialog { width: 200px; }
      button { width: 140px; height: 44px; }
    </style><section><dialog><button>Save draft</button></dialog></section>`)
    await page.locator('dialog').evaluate((element) => { (element as HTMLDialogElement).showModal() })
    await auditResponsiveControls(page, page.locator('dialog'), 'native-modal')
  } finally { await page.close() }
})

it.each(['hidden', 'auto'] as const)('checks required controls before an overflow %s container can be moved', async (overflow) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>
      body { margin: 0; }
      section { width: 200px; height: 100px; overflow: ${overflow}; }
      button { width: 140px; height: 44px; margin-top: 180px; }
    </style><section><button>Save draft</button></section>`)
    const check = expectViewportFit(page, page.locator('section'), [page.getByRole('button', { name: 'Save draft' })])
    if (overflow === 'hidden') await expect(check).rejects.toThrow('non-scrollable hidden or clip ancestor')
    else await check
  } finally { await page.close() }
})

it('ignores a collapsed noninteractive field without moving its hidden ancestor', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>
      section { width: 200px; height: 100px; overflow: hidden; }
      input { width: 0; padding: 2px; margin-left: 220px; opacity: 0; pointer-events: none; }
    </style><section><input aria-hidden="true" tabindex="-1"></section>`)
    await auditResponsiveControls(page, page.locator('section'), 'collapsed-search')
    expect(await page.locator('section').evaluate(element => element.scrollLeft)).toBe(0)
    await page.locator('input').evaluate((element) => { element.setAttribute('tabindex', '0') })
    await expect(auditResponsiveControls(page, page.locator('section'), 'hidden-focusable-search'))
      .rejects.toThrow('non-scrollable hidden or clip ancestor')
  } finally { await page.close() }
})

it('centers a focused field inside its user-scrollable ancestor', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>
      body { margin: 0; }
      section { width: 200px; height: 100px; overflow: auto; }
      input { width: 140px; height: 44px; margin-block: 180px; }
    </style><section><input aria-label="Draft"></section>`)
    await page.getByRole('textbox', { name: 'Draft' }).focus()
    await auditResponsiveControl(page, page.getByRole('textbox', { name: 'Draft' }), 'focused-draft', 'center')
    expect(await page.locator('section').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  } finally { await page.close() }
})

it.each([
  { position: 'fixed', parent: 'position:relative;', clipped: false },
  { position: 'fixed', parent: 'transform:translateX(0);', clipped: true },
  { position: 'absolute', parent: '', clipped: false },
  { position: 'absolute', parent: 'position:relative;', clipped: true },
])('applies $position clipping only at its actual containing block: $parent', async ({ position, parent, clipped }) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>
      body { margin: 0; position: relative; }
      section { ${parent} margin-top:40px; width:200px; height:20px; overflow:hidden; }
      button { position:${position}; top:16px; left:20px; width:140px; height:44px; }
    </style><section><button>Save draft</button></section>`)
    const check = auditResponsiveControls(page, page.locator('section'), 'positioned-menu')
    if (clipped) await expect(check).rejects.toThrow(/unclipped control|non-scrollable hidden or clip ancestor/)
    else await check
  } finally { await page.close() }
})

const semanticControls = [
  { kind: 'link', html: '<a class="control" href="#destination">Read details</a>' },
  { kind: 'summary', html: '<details><summary class="control">More options</summary></details>' },
  ...['button', 'menuitem', 'tab', 'treeitem'].map(role => ({
    kind: role, html: `<div class="control" role="${role}" tabindex="0">Open item</div>`,
  })),
]

it.each(semanticControls.flatMap(control => (['hidden', 'auto'] as const).map(overflow => ({ ...control, overflow }))))(
  'checks a semantic $kind inside overflow $overflow', async ({ html, overflow }) => {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    try {
      await page.setContent(`<style>
        body { margin:0; } section { width:200px; height:100px; overflow:${overflow}; }
        .control { display:block; width:140px; height:44px; margin-top:180px; }
      </style><section>${html}</section>`)
      const check = auditResponsiveControls(page, page.locator('section'), `semantic-${overflow}`)
      if (overflow === 'hidden') await expect(check).rejects.toThrow('non-scrollable hidden or clip ancestor')
      else await check
    } finally { await page.close() }
  },
)

it('accepts a fully readable inline link without requiring a button-sized target', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent('<p style="font-size:14px">Read the <a href="#destination">reference</a>.</p>')
    await auditResponsiveControls(page, page.locator('body'), 'inline-link')
    expect((await page.locator('a').boundingBox())?.height).toBeLessThan(44)
  } finally { await page.close() }
})

it('inspects the active native dialog while its document and earlier modal are inert', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>
      section { width:200px; height:100px; overflow:hidden; }
      .clipped { margin-top:180px; } dialog { width:200px; height:120px; } button { height:44px; }
    </style><section><button class="clipped">Background</button></section>
    <div inert><dialog id="top"><button>Active action</button></dialog></div>
    <dialog id="earlier"><section><button class="clipped">Earlier action</button></section></dialog>`)
    await page.locator('#earlier').evaluate((element) => { (element as HTMLDialogElement).showModal() })
    await page.locator('#top').evaluate((element) => { (element as HTMLDialogElement).showModal() })
    await page.locator('section').evaluateAll((elements) => { for (const element of elements) element.scrollTop = 0 })
    await auditResponsiveControls(page, page.locator('body'), 'active-modal')
    expect(await page.locator('section').evaluateAll(elements => elements.map(element => element.scrollTop))).toEqual([0, 0])
  } finally { await page.close() }
})

it('checks an independently focusable tree item without treating its noninteractive grouping wrapper as an action', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent('<div role="treeitem" style="position:fixed;height:600px"><button style="height:44px">Open branch</button></div>')
    await auditResponsiveControls(page, page.locator('body'), 'tree-group')
    await page.locator('[role="treeitem"]').evaluate((element) => { element.setAttribute('tabindex', '0') })
    await expect(auditResponsiveControls(page, page.locator('body'), 'focusable-tree-item')).rejects.toThrow('reachable control')
  } finally { await page.close() }
})

const sizedControls = [
  '<button class="control">Go</button>',
  '<div class="control" role="button" tabindex="0">Go</div>',
  '<div class="control" role="menuitem" tabindex="0">Go</div>',
  '<div class="control" role="menuitemcheckbox" aria-checked="false" tabindex="0">Go</div>',
  '<div class="control" role="menuitemradio" aria-checked="false" tabindex="0">Go</div>',
  '<div class="control" role="tab" tabindex="0">Go</div>',
  '<div class="control" role="treeitem" tabindex="0">Go</div>',
  '<div class="control" role="checkbox" aria-checked="false" tabindex="0">Go</div>',
  '<div class="control" role="radio" aria-checked="false" tabindex="0">Go</div>',
  '<div class="control" role="switch" aria-checked="false" tabindex="0">Go</div>',
  '<div class="control" role="combobox" aria-expanded="false" tabindex="0">Go</div>',
  '<div class="control" role="textbox" contenteditable="true" tabindex="0"></div>',
  '<details><summary class="control">Go</summary></details>',
  '<input class="control" aria-label="Name">',
  '<textarea class="control" aria-label="Draft"></textarea>',
  '<select class="control" aria-label="Choice"><option>A</option></select>',
  '<nav><a class="control" href="#destination">Go</a></nav>',
]

it.each(sizedControls.flatMap(html => [false, true].map(hasTouch => ({ html, hasTouch }))))(
  'checks each independent target size with touch=$hasTouch: $html', async ({ html, hasTouch }) => {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch })
    try {
      const minimum = hasTouch ? 44 : 24
      await page.setContent(`<style>body{margin:30px}.control{display:block;box-sizing:border-box;padding:0;border:0;
        width:${minimum}px;height:${minimum - 1}px}</style>${html}`)
      await expect(auditResponsiveControls(page, page.locator('body'), 'short-target')).rejects.toThrow(`effective ${minimum}px target`)
      await page.locator('.control').evaluate((node, size) => { (node as HTMLElement).style.height = `${size}px`; (node as HTMLElement).style.width = `${size - 1}px` }, minimum)
      await expect(auditResponsiveControls(page, page.locator('body'), 'narrow-target')).rejects.toThrow(`effective ${minimum}px target`)
      await page.locator('.control').evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, minimum)
      await auditResponsiveControls(page, page.locator('body'), 'sized-target')
    } finally { await page.close() }
  },
)

it('rejects the fully visible one-pixel image button that geometry alone accepts', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<p><button style="padding:0;border:0;width:1px;height:1px" aria-label="Preview"><img width="1" height="1" alt=""></button></p>')
    await expect(auditResponsiveControls(page, page.locator('body'), 'one-pixel-preview')).rejects.toThrow('effective 44px target')
  } finally { await page.close() }
})

it.each(['wrapped', 'for'] as const)('uses an actual %s label target without toggling its checkbox', async (kind) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    const input = '<input id="choice" type="checkbox">'
    await page.setContent('<style>label{display:inline-flex;width:100px;height:44px;align-items:center}</style>'
      + (kind === 'wrapped' ? `<label>${input}<span>Enable</span></label>` : `<label for="choice"><span>Enable</span></label>${input}`))
    await auditResponsiveControls(page, page.locator('body'), `checkbox-${kind}`)
    expect(await page.getByRole('checkbox').isChecked()).toBe(false)
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  } finally { await page.close() }
})

it('does not count gaps between label line fragments as a large target', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<div style="width:65px;font:16px/24px monospace"><label for="choice">Alpha Beta Gamma Delta</label></div><input id="choice" type="checkbox">')
    expect(await page.locator('label').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(44)
    await expect(auditResponsiveControls(page, page.locator('body'), 'fragmented-label')).rejects.toThrow('effective 44px target')
  } finally { await page.close() }
})

it('checks the actual fragment of a contents label instead of skipping its hidden input', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<label style="display:contents"><input type="checkbox" style="display:none"><span style="display:inline-block;width:1px;height:1px">Enable</span></label>')
    await expect(auditResponsiveControls(page, page.locator('body'), 'contents-label-tiny')).rejects.toThrow('effective 44px target')
    await page.locator('span').evaluate((node) => { node.style.width = '100px'; node.style.height = '44px' })
    await auditResponsiveControls(page, page.locator('body'), 'contents-label-sized')
    expect(await page.getByRole('checkbox', { includeHidden: true }).isChecked()).toBe(false)
  } finally { await page.close() }
})

it('keeps an interactive popover root outside its ordinary clipping ancestors', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<section style="width:20px;height:20px;overflow:hidden"><div popover role="button" tabindex="0" style="width:100px;height:44px">Action</div></section>')
    await page.getByRole('button', { includeHidden: true }).evaluate((node) => {
      if (!(node instanceof HTMLElement)) throw new Error('Popover fixture is not HTML')
      node.showPopover()
    })
    await auditResponsiveControls(page, page.getByRole('button'), 'popover-root')
  } finally { await page.close() }
})

it('accepts a generated hit extension only when its points reach the same action', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent(`<style>body{margin:40px}button{position:relative;width:24px;height:24px;padding:0;border:0}
      button::after{content:"";position:absolute;inset:-10px}</style><button aria-label="Action">+</button>`)
    await auditResponsiveControls(page, page.locator('body'), 'extended-target')
    await page.addStyleTag({ content: 'button::after{inset:-9.5px}' })
    await expect(auditResponsiveControls(page, page.locator('body'), 'short-extension')).rejects.toThrow('effective 44px target')
    await page.addStyleTag({ content: 'button::after{inset:-10px}' })
    await page.locator('body').evaluate((node) => { node.insertAdjacentHTML('beforeend', '<div style="position:fixed;left:30px;top:30px;width:10px;height:44px"></div>') })
    await expect(auditResponsiveControls(page, page.locator('body'), 'blocked-extension')).rejects.toThrow('actual pointer hit')
  } finally { await page.close() }
})

it('keeps prose links exempt from target size while checking their actual hit', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<p>Read <a href="#help">help</a> before continuing.</p>')
    await auditResponsiveControls(page, page.locator('body'), 'prose-link')
    await page.locator('body').evaluate((node) => { node.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0"></div>') })
    await expect(auditResponsiveControls(page, page.locator('body'), 'covered-prose-link')).rejects.toThrow('actual pointer hit')
  } finally { await page.close() }
})

const proseTargets = [
  '<span>Open the </span><button class="control">file</button><span> for details.</span>',
  'Open the <span><button class="control">file</button></span> for details.',
  'Open the <span class="control" role="button" tabindex="0">file</span> for details.',
  'Read the <a class="control" href="#reference">reference</a> before continuing.',
]

it.each(proseTargets.flatMap(html => ['inline', 'inline-flex'].map(display => ({ html, display }))))(
  'recognizes a $display action constrained by real non-target prose: $html', async ({ html, display }) => {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
    try {
      await page.setContent(`<style>.message{font:16px/24px sans-serif}.control{display:${display};font:inherit;
        padding:0;border:0;height:20px}</style><div class="message">${html}</div>`)
      await auditResponsiveControls(page, page.locator('.message'), 'inline-prose-action')
      await page.locator('body').evaluate((node) => {
        node.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0"></div>')
      })
      await expect(auditResponsiveControls(page, page.locator('.message'), 'covered-inline-action')).rejects.toThrow('actual pointer hit')
    } finally { await page.close() }
  },
)

const independentTargets = [
  '<p><button class="control">Only action</button></p>',
  '<p><button class="control">One</button> <button class="control">Two</button></p>',
  '<p style="display:flex">Read <button class="control">Action</button> now.</p>',
  '<p>Read <button class="control" style="position:absolute">Action</button> now.</p>',
  '<nav><p>Read <button class="control">Action</button> now.</p></nav>',
  '<div role="toolbar"><p>Read <button class="control">Action</button> now.</p></div>',
  '<div role="menu"><p>Read <button class="control" role="menuitem">Action</button> now.</p></div>',
  '<div><p>Separate paragraph.</p><button class="control">Action</button></div>',
  '<p><span style="display:none">Hidden sentence</span><button class="control">Action</button></p>',
  '<p><span style="opacity:0">Invisible sentence</span><button class="control">Action</button></p>',
  '<p>Read <button class="control" style="height:32px">Action</button> now.</p>',
]

it.each(independentTargets)('does not exempt an independent action merely placed in prose markup: %s', async (html) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent(`<style>body{font:16px/24px sans-serif}.control{display:inline-flex;font:inherit;padding:0;border:0;height:20px}</style>${html}`)
    await expect(auditResponsiveControls(page, page.locator('body'), 'independent-prose-markup')).rejects.toThrow('effective 44px target')
  } finally { await page.close() }
})

it('does not treat feedback prose as a pointer target', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<div role="status" style="height:18px">Pending review</div>')
    await auditResponsiveControl(page, page.getByRole('status'), 'readable-status')
  } finally { await page.close() }
})

it('skips disabled hit checks while preserving readable geometry', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<button disabled style="height:20px">Wait</button><div style="position:fixed;inset:0"></div>')
    await auditResponsiveControls(page, page.locator('body'), 'disabled-button')
    await page.locator('button').evaluate((node) => { node.style.position = 'fixed'; node.style.top = '300px' })
    await expect(auditResponsiveControls(page, page.locator('body'), 'clipped-disabled')).rejects.toThrow('reachable control')
  } finally { await page.close() }
})

it.each(['auto', 'hidden'] as const)('centers a sticky-covered target only inside overflow %s', async (overflow) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent(`<style>body{margin:0}section{height:180px;overflow:${overflow}}header{position:sticky;top:0;height:60px;background:white;z-index:1}
      button{display:block;width:120px;height:44px;margin-top:60px}.tail{height:400px}</style><section><header>Header</header><button>Save</button><div class="tail"></div></section>`)
    await page.locator('section').evaluate((node) => { node.scrollTop = 120 })
    const check = auditResponsiveControls(page, page.locator('section'), `sticky-${overflow}`)
    if (overflow === 'auto') await check
    else {
      await expect(check).rejects.toThrow('actual pointer hit')
      expect(await page.locator('section').evaluate(node => node.scrollTop)).toBe(120)
    }
  } finally { await page.close() }
})

function coveredScrollport(overflow: 'auto' | 'hidden', room = true, covered = false): string {
  return `<style>
    body{margin:0}#sentinel{position:fixed;left:10px;top:10px;width:100px}
    section{position:fixed;left:55px;top:78px;width:869px;height:343px;overflow:${overflow};scroll-behavior:smooth}
    #content{position:relative;height:${room ? 513 : 343}px}
    #copy{position:absolute;left:734.5px;top:150px;box-sizing:border-box;width:44px;height:44px;padding:0;border:0}
    #return{position:fixed;left:789.5px;top:202px;width:44px;height:44px;background:silver}
    #footer{position:fixed;left:125px;top:261px;width:726px;height:128px;background:white}
    #cover{position:fixed;left:55px;top:78px;width:869px;height:343px;background:silver}
  </style><input id="sentinel" value="retained draft"><section><div id="content">
    <button id="copy" aria-label="Copy" data-activations="0">Copy</button>
  </div></section><div id="return"></div><div id="footer"></div>${covered ? '<div id="cover"></div>' : ''}`
}

async function rectangularHits(control: Locator): Promise<boolean[]> {
  return control.evaluate((node) => {
    const box = node.getBoundingClientRect(), hits: boolean[] = []
    for (const x of [box.left + 1, box.left + box.width / 2, box.right - 1]) {
      for (const y of [box.top + 1, box.top + box.height / 2, box.bottom - 1]) {
        let hit = document.elementFromPoint(x, y)
        while (hit?.shadowRoot !== null && hit?.shadowRoot !== undefined) {
          const inner = hit.shadowRoot.elementFromPoint(x, y)
          if (inner === null || inner === hit) break
          hit = inner
        }
        hits.push(hit !== null && (hit === node || node.contains(hit)))
      }
    }
    return hits
  })
}

it.each([false, true])('scrolls a center-clickable but covered 44px target into full reach with shadow=%s', async (shadow) => {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, hasTouch: true })
  try {
    await page.setContent(coveredScrollport('auto'))
    if (shadow) await page.locator('#content').evaluate((node) => {
      node.innerHTML = ''
      node.attachShadow({ mode: 'open' }).innerHTML = '<button aria-label="Copy" data-activations="0" style="position:absolute;left:734.5px;top:150px;box-sizing:border-box;width:44px;height:44px;padding:0;border:0">Copy</button>'
    })
    const copy = page.getByRole('button', { name: 'Copy', exact: true })
    await copy.evaluate((node) => { node.addEventListener('click', () => { node.setAttribute('data-activations', '1') }) })
    await page.locator('#sentinel').focus()
    const initial = await rectangularHits(copy)
    expect(initial[4]).toBe(true)
    expect(initial.some(hit => !hit)).toBe(true)
    await auditResponsiveControl(page, copy, 'two-overlays-scrollable-copy')
    expect(await rectangularHits(copy)).toEqual(Array.from({ length: 9 }, () => true))
    expect(await page.locator('section').evaluate(node => node.scrollTop)).toBeGreaterThan(50)
    expect(await copy.getAttribute('data-activations')).toBe('0')
    expect(await page.locator('#sentinel').inputValue()).toBe('retained draft')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('sentinel')
  } finally { await page.close() }
})

it.each([
  { name: 'hidden overflow', overflow: 'hidden' as const, room: true, covered: false },
  { name: 'no remaining scroll range', overflow: 'auto' as const, room: false, covered: false },
  { name: 'entire scrollport covered', overflow: 'auto' as const, room: true, covered: true },
])('keeps a covered target rejected with $name', async ({ overflow, room, covered }) => {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, hasTouch: true })
  try {
    await page.setContent(coveredScrollport(overflow, room, covered))
    await expect(auditResponsiveControl(page, page.getByRole('button', { name: 'Copy', exact: true }), 'no-visible-target-region'))
      .rejects.toThrow('actual pointer hit')
    expect(await page.locator('section').evaluate(node => node.scrollTop)).toBe(0)
  } finally { await page.close() }
})

it('uses a blocker edge when the horizontal center and both scrollport edges are covered', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent(`<style>body{margin:0}section{width:300px;height:180px;overflow:auto}
      #content{position:relative;width:600px;height:160px}button{position:absolute;left:200px;top:70px;width:44px;height:44px;padding:0;border:0}
      aside{position:fixed;top:0;height:180px;background:silver}#left{left:0;width:70px}#middle{left:129px;width:42px}#right{left:230px;width:90px}
    </style><section><div id="content"><button>Save</button></div></section><aside id="left"></aside><aside id="middle"></aside><aside id="right"></aside>`)
    const control = page.getByRole('button', { name: 'Save', exact: true })
    expect((await rectangularHits(control)).some(hit => !hit)).toBe(true)
    await auditResponsiveControl(page, control, 'horizontal-overlay-gap')
    expect(await rectangularHits(control)).toEqual(Array.from({ length: 9 }, () => true))
    expect(await page.locator('section').evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
  } finally { await page.close() }
})

it('retains parent-frame hit checks after legally scrolling inside a child frame', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 500 }, hasTouch: true })
  try {
    await page.setContent('<style>body{margin:0}iframe{display:block;width:932px;height:430px;border:0}</style><iframe></iframe>')
    await page.locator('iframe').evaluate((node, content) => {
      if (!(node instanceof HTMLIFrameElement)) throw new Error('Scroll fixture needs an iframe')
      node.srcdoc = content
    }, coveredScrollport('auto'))
    const copy = page.frameLocator('iframe').getByRole('button', { name: 'Copy', exact: true })
    await auditResponsiveControl(page, copy, 'scrollable-frame-target')
    expect(await rectangularHits(copy)).toEqual(Array.from({ length: 9 }, () => true))
    await page.locator('body').evaluate((node) => { node.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0"></div>') })
    await expect(auditResponsiveControl(page, copy, 'covered-scrollable-frame')).rejects.toThrow('actual pointer hit')
  } finally { await page.close() }
})

it('does not scroll the document when its body locks scrolling', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent(`<style>html{overflow:visible}body{margin:0;overflow:hidden}main{height:1000px}
      button{position:absolute;top:100px;left:40px;width:100px;height:44px}aside{position:fixed;left:0;top:90px;width:320px;height:60px}
    </style><main><button>Save</button></main><aside></aside>`)
    await expect(auditResponsiveControl(page, page.getByRole('button', { name: 'Save' }), 'locked-document'))
      .rejects.toThrow('actual pointer hit')
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(0)
  } finally { await page.close() }
})

it('does not turn a target removed by a scroll handler into a passing inspection', async () => {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, hasTouch: true })
  try {
    await page.setContent(coveredScrollport('auto'))
    await page.locator('section').evaluate((node) => {
      node.addEventListener('scroll', () => { node.querySelector('button')?.remove() }, { once: true })
    })
    await expect(auditResponsiveControl(page, page.getByRole('button', { name: 'Copy' }), 'removed-during-scroll'))
      .rejects.toThrow('probe detached its target')
  } finally { await page.close() }
})

it('reports a bounded probe as incomplete instead of claiming exhaustive unreachability', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    const nested = '<section>'.repeat(36) + '<button>Save</button>' + '<div class="tail"></div></section>'.repeat(36)
    await page.setContent(`<style>body{margin:0}section{width:200px;height:200px;overflow:auto}
      button{display:block;margin-top:80px;width:100px;height:44px}.tail{height:400px}aside{position:fixed;inset:0}
    </style>${nested}<aside></aside>`)
    await expect(auditResponsiveControl(page, page.getByRole('button', { name: 'Save' }), 'bounded-probe'))
      .rejects.toThrow('bounded scroll probe incomplete')
    expect(await page.locator('section').evaluateAll(nodes => nodes.every(node => node.scrollTop === 0))).toBe(true)
  } finally { await page.close() }
})

it('rejects a nested independent action covering a checkbox label', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<label for="choice" style="display:block;width:120px;height:44px"><a href="#help" style="display:block;width:120px;height:44px">Help</a></label><input id="choice" type="checkbox">')
    await expect(auditResponsiveControls(page, page.locator('body'), 'label-other-action')).rejects.toThrow('actual pointer hit')
  } finally { await page.close() }
})

it('accepts a separate full-size label region beside an independent help action', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<label for="choice" style="display:block;position:relative;width:160px;height:44px">Enable<a href="#help" style="position:absolute;left:58px;top:0;width:44px;height:44px;display:block">Help</a></label><input id="choice" type="checkbox">')
    await auditResponsiveControls(page, page.locator('body'), 'label-independent-region')
  } finally { await page.close() }
})

it('checks shadow target ownership instead of accepting any hit on its host', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<div id="host"></div>')
    await page.locator('#host').evaluate((host) => { host.attachShadow({ mode: 'open' }).innerHTML = '<button style="width:100px;height:44px"><span>Save</span></button>' })
    await auditResponsiveControls(page, page.locator('#host'), 'shadow-hit')
    await page.locator('#host').evaluate((host) => { host.shadowRoot!.innerHTML += '<div style="position:fixed;inset:0"></div>' })
    await expect(auditResponsiveControls(page, page.locator('#host'), 'shadow-obscured')).rejects.toThrow('actual pointer hit')
  } finally { await page.close() }
})

it('maps iframe-local hit regions through its border and parent overlay without activating them', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<iframe title="Controls" sandbox="allow-scripts" style="margin:20px;border:5px solid;width:220px;height:160px"></iframe>')
    await page.locator('iframe').evaluate((node) => {
      if (!(node instanceof HTMLIFrameElement)) throw new Error('Iframe fixture is not an iframe')
      node.srcdoc = '<button style="width:120px;height:44px">Save</button>'
    })
    const surface = page.frameLocator('iframe').locator('body')
    await surface.getByRole('button').waitFor()
    await auditResponsiveControls(page, surface, 'iframe-hit')
    await page.locator('body').evaluate((node) => { node.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0"></div>') })
    await expect(auditResponsiveControls(page, surface, 'iframe-covered')).rejects.toThrow('actual pointer hit')
  } finally { await page.close() }
})

it('measures a scaled iframe target in the outer viewport CSS pixels', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, hasTouch: true })
  try {
    await page.setContent('<iframe title="Scaled controls" style="width:240px;height:180px;transform:scale(.5);transform-origin:0 0"></iframe>')
    await page.locator('iframe').evaluate((node) => {
      if (!(node instanceof HTMLIFrameElement)) throw new Error('Iframe fixture is not an iframe')
      node.srcdoc = '<button style="width:88px;height:44px">Save</button>'
    })
    const surface = page.frameLocator('iframe').locator('body')
    await surface.getByRole('button').waitFor()
    await expect(auditResponsiveControls(page, surface, 'scaled-small')).rejects.toThrow('effective 44px target')
    await surface.getByRole('button').evaluate((node) => { node.style.height = '88px' })
    await auditResponsiveControls(page, surface, 'scaled-large')
  } finally { await page.close() }
})

it('only waits for scrolling when a control is outside its visible scrollport', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>
      body { margin:0; } section { width:200px; height:100px; overflow:auto; }
      button { display:block; height:44px; } button + button { margin-top:180px; }
    </style><section><button>Visible</button><button>Below</button></section>`)
    const handle = await page.getByRole('button', { name: 'Visible', exact: true }).elementHandle()
    if (handle === null) throw new Error('Visible fixture button is absent')
    const prototype = Object.getPrototypeOf(handle) as typeof handle
    const scroll = vi.spyOn(prototype, 'scrollIntoViewIfNeeded')
    try {
      await auditResponsiveControls(page, page.locator('section'), 'scroll-only-when-needed')
      expect(scroll).toHaveBeenCalledTimes(1)
    } finally { scroll.mockRestore(); await handle.dispose() }
  } finally { await page.close() }
})

it.each(['hidden', 'auto'] as const)('follows shadow hosts into an overflow %s ancestor', async (overflow) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent(`<style>body{margin:0}section{width:200px;height:100px;overflow:${overflow}}</style>
      <section><div id="host"></div></section>`)
    await page.locator('#host').evaluate((host) => {
      host.attachShadow({ mode: 'open' }).innerHTML = '<button style="width:140px;height:44px;margin-top:180px">Shadow action</button>'
    })
    const check = auditResponsiveControls(page, page.locator('section'), `shadow-${overflow}`)
    if (overflow === 'hidden') await expect(check).rejects.toThrow('non-scrollable hidden or clip ancestor')
    else await check
  } finally { await page.close() }
})

it.each(['hidden', 'auto'] as const)('follows assigned slots into an overflow %s shadow scrollport', async (overflow) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent('<div id="host"><button style="width:140px;height:44px;margin-top:180px">Slotted action</button></div>')
    await page.locator('#host').evaluate((host, value) => {
      host.attachShadow({ mode: 'open' }).innerHTML = `<section style="width:200px;height:100px;overflow:${value}"><slot></slot></section>`
    }, overflow)
    const check = auditResponsiveControls(page, page.locator('#host'), `slot-${overflow}`)
    if (overflow === 'hidden') await expect(check).rejects.toThrow('non-scrollable hidden or clip ancestor')
    else await check
  } finally { await page.close() }
})

it('checks shadow controls in a native modal and ignores a separate inert shadow tree', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.setContent('<div inert><div id="hidden"></div></div><dialog><div id="active"></div></dialog>')
    for (const id of ['hidden', 'active']) await page.locator(`#${id}`).evaluate((host) => {
      host.attachShadow({ mode: 'open' }).innerHTML = '<section style="width:180px;height:100px;overflow:hidden"><button style="margin-top:180px">Shadow action</button></section>'
    })
    await page.locator('dialog').evaluate((dialog) => { (dialog as HTMLDialogElement).showModal() })
    await page.locator('#active section').evaluate((section) => { section.scrollTop = 0 })
    await expect(auditResponsiveControls(page, page.locator('body'), 'shadow-in-modal')).rejects.toThrow('non-scrollable hidden or clip ancestor')
    expect(await page.locator('#hidden section').evaluate(section => section.scrollTop)).toBe(0)
  } finally { await page.close() }
})
