/** Native detachment feedback with an authenticated, live node-service connection. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import WebSocket from 'ws'

/**
 * Retain the computer lease when an existing connection prevents detachment.
 * @param options - actual Admin page, primary entry and authorized remote Runtime.
 * @returns after closing the owned socket and the confirmation dialog.
 */
export async function adminDetachmentBrowser({ page, primary, remoteCookie, remoteRuntime }) {
  const access = () => page.evaluate(async () => {
    const response = await fetch('/admin/api/deployment/nodes/access')
    if (!response.ok) throw Error(`Computer access read failed: ${response.status}`)
    return response.json()
  })
  const before = (await access()).items.find(node => node.name === 'computer-b')
  assert.ok(before)
  const row = page.getByRole('row').filter({ hasText: 'computer-b' })
  await row.getByRole('button', { name: '退出接入', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '让 computer-b 退出接入', exact: true })
  await dialog.waitFor()
  const url = new URL('/api/events.host', primary)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('dshRuntime', remoteRuntime)
  const socket = new WebSocket(url, { headers: { cookie: remoteCookie, origin: primary }, handshakeTimeout: 60000 })
  const closed = new Promise(resolve => { socket.once('close', resolve) })
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const response = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/admin/api/deployment/nodes/access/${before.nodeId}`, { timeout: 60000 })
    void response.catch(() => {})
    await dialog.getByRole('button', { name: '退出接入', exact: true }).click()
    const refused = await response
    assert.equal(refused.status(), 409)
    assert.equal((await refused.json()).error, 'node-service/busy')
    const notice = dialog.getByRole('alert')
    await notice.filter({ hasText: '关闭这台电脑的工作台' }).waitFor()
    const after = (await access()).items.find(node => node.nodeId === before.nodeId)
    assert.ok(after)
    assert.equal(after.revision, before.revision)
    assert.equal(after.status, 'connected')
    const actual = ['Admin detachment with a live connection', 'native refusal: 409 node-service/busy',
      (await notice.innerText()).trim(), 'computer identity and lease revision preserved', ''].join('\n')
    const expected = new URL('../expected/admin-detachment.txt', import.meta.url)
    if (['record', 'refresh'].includes(process.env.DSH_SNAPSHOT)) await writeFile(expected, actual)
    assert.equal(actual, await readFile(expected, 'utf8'))
  } finally {
    socket.terminate()
    await closed
    if (await dialog.count() > 0) await dialog.getByRole('button', { name: '取消', exact: true }).click()
  }
}
