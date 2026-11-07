/** Native Admin project actions against the caller's two assembled Gateways. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

/**
 * Exercise project governance on a selected computer without starting its Runtime.
 * @param options - owned browser page, primary origin and independent persisted-state check.
 * @returns after the original project model and quota choices are restored.
 */
export async function adminProjectBrowser({ page, primary, verifyPassive }) {
  const contextResponse = await page.request.get(`${primary}/admin/api/deployment/current-node`)
  assert.equal(contextResponse.status(), 200)
  const center = await contextResponse.json()
  const localPath = `/admin/computers/${center.nodeId}`
  await page.goto(`${primary}${localPath}`)
  const localChooser = page.getByRole('combobox', { name: '管理电脑', exact: true })
  const localOption = localChooser.getByRole('option', { name: `中心电脑 · ${center.name}`, exact: true })
  await localOption.waitFor({ state: 'attached' })
  assert.equal(await localChooser.inputValue(), '')
  assert.equal(await localChooser.getByRole('option', { name: `电脑 ${center.nodeId.slice(0, 8)}`, exact: true }).count(), 0)
  assert.equal(new URL(page.url()).pathname, localPath)
  const nodeId = await page.locator('select option').filter({ hasText: 'computer-b' }).getAttribute('value')
  assert.ok(nodeId)
  const chooser = page.locator('select').filter({ has: page.locator(`option[value="${nodeId}"]`) })
  await chooser.selectOption(nodeId)
  await page.getByRole('link', { name: '项目', exact: true }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByPlaceholder('例如：产品文档', { exact: true }).fill('Admin project governance')
  const read = path => page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === path, { timeout: 60000 })
  const reads = Promise.all(['/admin/api/project-model-access', '/admin/api/usage', '/admin/api/usage/contributors'].map(read))
  void reads.catch(() => {})
  const [created] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/admin/api/projects', { timeout: 60000 }),
    page.getByRole('button', { name: '创建项目', exact: true }).click(),
  ])
  assert.equal(created.status(), 200, await created.text())
  assert.equal(new URL(created.url()).searchParams.get('dshNode'), nodeId)
  const project = await created.json()
  await verifyPassive(project.id)
  await page.getByRole('link', { name: 'Admin project governance', exact: true }).click()
  await page.getByRole('heading', { name: 'Admin project governance', exact: true }).waitFor()
  const initial = await reads
  for (const response of initial) {
    assert.equal(response.status(), 200, `${new URL(response.url()).pathname}: ${await response.text()}`)
    assert.equal(new URL(response.url()).searchParams.get('dshNode'), nodeId)
    assert.equal(new URL(response.url()).searchParams.get('projectId'), String(project.id))
  }
  await verifyPassive(project.id)
  const lines = ['Admin remote project governance', 'explicit primary route: one named current-computer option',
    'native project creation: computer-b, runtime never started']
  for (const response of initial) lines.push(`${new URL(response.url()).pathname}: 200 computer-b`)

  const mutation = async (path, action) => {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === path, { timeout: 60000 }),
      action(),
    ])
    if (response.status() !== 204) assert.fail(`${path}: HTTP ${response.status()} ${await response.text()}`)
    assert.equal(new URL(response.url()).searchParams.get('dshNode'), nodeId)
    return response
  }
  const toggle = () => page.getByRole('row').filter({ hasText: 'Fixture Chat' }).getByRole('checkbox')
  const original = await toggle().isChecked()
  for (const desired of [!original, original]) {
    await mutation('/admin/api/project-model-access', () => toggle().locator('..').click())
    await page.waitForFunction(expected => {
      const row = Array.from(document.querySelectorAll('tr')).find(item => item.textContent.includes('Fixture Chat'))
      const input = row?.querySelector('input[type="checkbox"]')
      return input !== null && input !== undefined && input.checked === expected && !input.disabled
    }, desired)
  }
  lines.push('native model assignment and restoration: 204 computer-b')
  for (const source of ['independent', 'inherit']) {
    await page.getByRole('button', { name: '配置额度', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '配置项目额度', exact: true })
    await dialog.getByRole('radio', { name: source === 'independent' ? /^项目独立额度/u : /^继承普通成员额度/u }).check()
    const updated = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/admin/api/projects/${project.id}`, { timeout: 60000 })
    void updated.catch(() => {})
    await mutation('/admin/api/quotas', () => dialog.getByRole('button', { name: '保存额度', exact: true }).click())
    const detail = await updated
    assert.equal(detail.status(), 200)
    assert.equal((await detail.json()).quota.source, source)
    await dialog.waitFor({ state: 'hidden' })
    lines.push(`native project quota ${source}: 204 computer-b`)
  }
  const overview = read('/admin/api/usage/overview')
  void overview.catch(() => {})
  await page.getByRole('link', { name: '用量', exact: true }).click()
  const shared = await overview
  assert.equal(shared.status(), 200)
  assert.equal(new URL(shared.url()).searchParams.has('dshNode'), false)
  lines.push('organization usage overview: 200 primary')
  await verifyPassive(project.id)
  lines.push('project runtime and creation generation preserved', '')
  const actual = lines.join('\n')
  const expected = new URL('../expected/admin-project-computer.txt', import.meta.url)
  if (['record', 'refresh'].includes(process.env.DSH_SNAPSHOT)) await writeFile(expected, actual)
  assert.equal(actual, await readFile(expected, 'utf8'))
  await page.goto(`${primary}/admin/deployment`)
}
