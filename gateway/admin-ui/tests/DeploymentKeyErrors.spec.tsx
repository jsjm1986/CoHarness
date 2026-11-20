/** Real HTTP decoding and visible maintenance errors share the same localized diagnostics. */
import { createServer } from 'node:http'
import { cleanup, render, screen } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { getNodeConfiguration } from '../src/api.ts'
import { NodeConfigurationSection } from '../src/pages/NodeConfigurationSection.tsx'
import { NODE_CONFIG_FIELDS } from '../../src/node-config-fields.ts'

vi.mock('../src/components/DesktopEnvironmentNotice.tsx', () => ({ DesktopEnvironmentNotice: () => null }))

const cases = [
  ['project-name-key-not-configured', '主入口尚未配置项目名称查重密钥。', 'The primary entry has no project-name uniqueness key configured.'],
  ['project-name-key-identity-mismatch', '项目名称查重密钥文件缺失、权限不符合要求或身份与指纹不匹配。', 'The registered project-name key file is missing, has unsafe permissions, or does not match its identity and fingerprint.'],
  ['backup-project-name-key-evidence-missing', '此备份缺少项目名称查重密钥的身份凭据，不能安全恢复。', 'This backup has no project-name key identity evidence and cannot be restored safely.'],
  ['backup-project-name-key-identity-ambiguous', '无法从备份唯一确定项目名称查重密钥的身份。', 'The backup does not identify one project-name key unambiguously.'],
  ['backup-project-name-key-location-changed', '备份中的项目名称查重密钥路径与当前配置不同。', 'The backed-up project-name key path differs from the current configuration.'],
  ['project-name-key-configuration-change-requires-explicit-migration', '不能在存储搬迁时新增或取消项目名称查重密钥配置。', 'Storage relocation cannot add or remove the project-name key configuration.'],
  ['peer-backup/personal-recovery-installation-pending', '此电脑有已验证但尚未发布的个人恢复候选，维护备份暂不能覆盖它的完整归属。', 'This computer has a verified personal recovery candidate that is not yet published.'],
  ['runtime-management/local-home-binding-required', '本机账号数据尚未核验。', 'Local account data has not been verified.'],
  ['peer-backup/governance-local-binding-required', '本机账号数据尚未核验。', 'Local account data has not been verified.'],
  ['peer-backup/governance-local-account-home-conflict', '此账号在本机已绑定其他数据目录。', 'This account is already bound to another home on this computer.'],
] as const

async function serve(body: unknown, status: number, language: 'zh' | 'en') {
  const paths: string[] = []
  const server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', request.headers.origin ?? '*')
    response.setHeader('access-control-allow-methods', 'GET, OPTIONS')
    response.setHeader('access-control-allow-headers', 'content-type')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    paths.push(request.url ?? '')
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  onTestFinished(async () => {
    cleanup()
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a private TCP listener')
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => fetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init))
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'coharness-admin-language' ? language : null })
  return paths
}

for (const language of ['zh', 'en'] as const) {
  it.each(cases)(`renders %s from a real HTTP rejection in ${language} while retaining its machine code`, async (code, zh, en) => {
    const paths = await serve(language === 'zh' ? { error: code } : { error: { code, message: 'Private diagnostic details' } }, 409, language)
    const prefix = language === 'zh' ? zh : en
    await expect(getNodeConfiguration()).rejects.toMatchObject({ code, message: expect.stringContaining(prefix) })
    render(<NodeConfigurationSection />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(prefix)
    expect(alert.textContent).not.toContain(code)
    expect(alert.textContent).not.toContain('Private diagnostic details')
    expect(paths).toEqual(['/admin/api/deployment/configuration', '/admin/api/deployment/configuration'])
  })
}

it('localizes a persisted node configuration failure without discarding desired settings', async () => {
  const values = Object.fromEntries(NODE_CONFIG_FIELDS.map(field => [field.key, field.kind === 'integer' ? '8899' : '']))
  await serve({ organizationId: 'org', nodeId: 'node', revision: 1, appliedRevision: 0, runningRevision: 0,
    desired: values, effective: values, configFile: '/private/config.json',
    operation: { revision: 1, status: 'failed', error: cases[5][0] } }, 200, 'zh')
  render(<NodeConfigurationSection />)
  expect((await screen.findByRole('alert')).textContent).toContain(cases[5][1])
  expect((screen.getByLabelText('Gateway 端口（1–65535）') as HTMLInputElement).value).toBe('8899')
})
