import { describe, expect, it } from 'vitest'
import { gateCopy, gateLanguage, loginPage, passwordPage, runtimeStartFailurePage, stoppedPage, waitingPage } from '../src/html.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'

describe('Gateway entry documents', () => {
  it('restarts the selected personal or project Runtime independently of another tab scope', () => {
    const runtimeId = '00000000-0000-4000-8000-000000000091' as RuntimeId
    for (const kind of ['user', 'project'] as const) {
      const page = stoppedPage({ kind, id: 12, runtimeId })
      expect(page).toContain(`action="/account/runtime/start?dshRuntime=${runtimeId}"`)
      expect(page).toContain(`name="kind" value="${kind === 'user' ? 'personal' : 'project'}"`)
      if (kind === 'project') expect(page).toContain('name="projectId" value="12"')
    }
    expect(stoppedPage({ kind: 'user', id: 12 })).toContain('action="/account/runtime/start"')
  })
  it('escapes and retains the intended UI address in both account forms', () => {
    for (const render of [loginPage, passwordPage]) {
      expect(render('', 'zh', '/?dshRuntime=test&name="<target>"')).toContain('name="returnTo" value="/?dshRuntime=test&amp;name=&quot;&lt;target&gt;&quot;"')
    }
  })

  it('escapes the original startup target while retaining an explicit project retry', () => {
    const page = runtimeStartFailurePage('busy', { kind: 'project', projectId: 12,
      action: '/account/runtime/start?dshRuntime=original&label="<target>"' }, 'en')
    expect(page).toContain('action="/account/runtime/start?dshRuntime=original&amp;label=&quot;&lt;target&gt;&quot;"')
    expect(page).toContain('method="post"')
    expect(page).toContain('name="kind" value="project"')
    expect(page).toContain('name="projectId" value="12"')
    expect(page).toContain('role="alert"')
    expect(page).toContain('<html lang="en">')
    expect(page).not.toContain('http-equiv="refresh"')
    expect(page).not.toContain('<script')
  })

  it('offers the environment directory without a startup form for a refused target', () => {
    const page = runtimeStartFailurePage('denied', null)
    expect(page).toContain('没有此工作环境的使用权限')
    expect(page).toContain('href="/?environments=1"')
    expect(page).not.toContain('<form')
    expect(page).not.toContain('http-equiv="refresh"')
  })
  it('uses the CoHarness product brand across account entry and startup pages', () => {
    expect(loginPage()).toContain('<title>登录 - COHARNESS</title>')
    expect(loginPage()).toContain('<h1 class="brand">')
    expect(loginPage()).toContain('>COHARNESS</span>')
    expect(passwordPage()).toContain('<title>修改密码 - COHARNESS</title>')
    expect(waitingPage()).toContain('<title>正在启动 - COHARNESS</title>')
    expect(waitingPage()).toContain('>COHARNESS</span>')
    expect(stoppedPage({ kind: 'user', id: 1 })).toContain('>COHARNESS</span>')
  })

  it('renders English gate pages when the language cookie selects it', () => {
    expect(loginPage('', 'en')).toContain('<title>Sign in - COHARNESS</title>')
    expect(loginPage('', 'en')).toContain('<span>Username</span>')
    expect(loginPage('', 'en')).toContain('<span>Password</span>')
    expect(passwordPage('', 'en')).toContain('<title>Change password - COHARNESS</title>')
    expect(waitingPage('en')).toContain('<title>Starting - COHARNESS</title>')
    expect(waitingPage('en')).toContain('Starting your workbench…')
    expect(stoppedPage({ kind: 'user', id: 1 }, 'en')).toContain('<title>Workbench stopped - COHARNESS</title>')
  })

  it('emits the matching html lang attribute per language', () => {
    expect(loginPage('', 'en')).toContain('<html lang="en">')
    expect(loginPage()).toContain('<html lang="zh-CN">')
  })
})

describe('gateLanguage', () => {
  it('reads the admin language cookie', () => {
    expect(gateLanguage('hgw_session=abc; hgw_lang=en')).toBe('en')
    expect(gateLanguage('hgw_lang=en')).toBe('en')
    expect(gateLanguage('hgw_lang=zh; hgw_session=abc')).toBe('zh')
    expect(gateLanguage('hgw_session=abc')).toBe('zh')
    expect(gateLanguage(undefined)).toBe('zh')
    expect(gateLanguage('hgw_lang=en; hgw_lang=zh')).toBe('en')
  })
})

describe('gateCopy', () => {
  it('interpolates {name} placeholders', () => {
    expect(gateCopy('zh')('passwordTooShort', { min: '8' })).toBe('密码至少 8 位')
    expect(gateCopy('en')('passwordTooShort', { min: '8' })).toBe('Password must be at least 8 characters.')
  })
})
