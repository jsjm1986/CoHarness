/** Explicit-device CDP connection for the Admin suite; owns only its test pages and loopback reverse. */
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { chromium, type Locator, type Page } from 'playwright'

const run = promisify(execFile)
/** Opt-in endpoint of the selected Android browser; ordinary runs launch local engines. */
export const adminAndroidEndpoint = process.env.DSH_ADMIN_ANDROID_CDP_ENDPOINT

/** Activate a real device with native touch events, or the declared emulated pointer. @param target - visible control. */
export async function activateAdminControl(target: Locator): Promise<void> {
  const page = target.page()
  if (adminAndroidEndpoint === undefined) {
    if ((page.viewportSize()?.width ?? 1280) < 1024) await target.tap()
    else await target.click()
    return
  }
  // Scroll-based actionability checks can reveal the focused editor and reopen
  // the IME after dismissal. Tap an already-visible target at its current point.
  const locate = () => target.evaluate(element => new Promise<{ x: number; y: number } | null>((resolve) => {
    if (window !== window.top) { resolve(null); return }
    let previous = '', stableSince = performance.now()
    const settle = (now: number) => {
      const box = element.getBoundingClientRect()
      const viewport = visualViewport
      const sample = [box.x, box.y, box.width, box.height, viewport?.height, viewport?.offsetTop].join(',')
      if (sample !== previous) { previous = sample; stableSince = now }
      if (now - stableSince < 200) { requestAnimationFrame(settle); return }
      const x = Math.round(box.left + box.width / 2)
      const y = Math.round(box.top + box.height / 2)
      if (viewport !== null && (x < viewport.offsetLeft || x >= viewport.offsetLeft + viewport.width
        || y < viewport.offsetTop || y >= viewport.offsetTop + viewport.height)) { resolve(null); return }
      resolve(element.contains(document.elementFromPoint(x, y)) ? { x, y } : null)
    }
    requestAnimationFrame(settle)
  }))
  let point = await locate()
  if (point === null) {
    await target.evaluate((node) =>{  node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }) })
    point = await locate()
  }
  if (point === null || !(await target.isEnabled())) throw new Error('Android touch target has no enabled hit point')
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally { await cdp.detach() }
}

async function androidShell(input: string): Promise<void> {
  const serial = process.env.DSH_ANDROID_SERIAL
  if (!adminAndroidEndpoint || !serial) throw new Error('Android input requires the selected test device')
  const command = process.env.DSH_ANDROID_ROOT === '1' ? `su -c '${input}'` : input
  await run('adb', ['-s', serial, 'shell', command])
}

/** Dismiss the native IME on the explicitly selected test device. */
export async function dismissAdminAndroidKeyboard(): Promise<void> {
  // The viewport can stay reduced briefly after the system has hidden the IME. Back would close a custom tab.
  await androidShell('if ! dumpsys input_method | grep -m 1 mInputShown | grep -q mInputShown=false; then input keyevent 4; fi')
}

/**
 * Tap the native keyboard on the explicitly selected test device.
 * @param point - The key's physical screen coordinates from a device capture.
 * @returns Completion of the Android touch command.
 */
export async function tapAndroidImeKey(point: string): Promise<void> {
  if (!/^\d+,\d+$/u.test(point)) throw new Error('Android IME key coordinates must be x,y in screen pixels')
  const [x, y] = point.split(',')
  await androidShell(`input tap ${x} ${y}`)
}

/** Save native Android chrome and keyboard alongside the page rendering. @param page - owned foreground page. @param path - output PNG. */
export async function screenshotAdminPage(page: Page, path: string): Promise<void> {
  if (adminAndroidEndpoint !== undefined) {
    const serial = process.env.DSH_ANDROID_SERIAL!
    const capture = await run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
    await writeFile(path.replace(/\.png$/, '-device.png'), capture.stdout)
  }
  await page.screenshot({ path, animations: 'disabled' })
}

/**
 * Connect an explicitly selected device to one private fixture server without replacing existing forwards.
 * @param base - loopback URL of this test's newly allocated server.
 * @returns connection plus cleanup for its CDP transport and owned reverse mapping.
 */
export async function connectAdminAndroid(base: string) {
  const serial = process.env.DSH_ANDROID_SERIAL
  if (adminAndroidEndpoint === undefined || serial === undefined || serial === '') {
    throw new Error('Android Admin tests require DSH_ADMIN_ANDROID_CDP_ENDPOINT and DSH_ANDROID_SERIAL')
  }
  const socket = `tcp:${new URL(base).port}`
  await run('adb', ['-s', serial, 'reverse', '--no-rebind', socket, socket])
  try {
    const browser = await chromium.connectOverCDP(adminAndroidEndpoint)
    return { browser, close: async () => {
      try { await browser.close() }
      finally { await run('adb', ['-s', serial, 'reverse', '--remove', socket]) }
    } }
  } catch (error) {
    await run('adb', ['-s', serial, 'reverse', '--remove', socket])
    throw error
  }
}
