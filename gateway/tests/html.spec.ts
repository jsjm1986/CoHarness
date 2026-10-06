import { describe, expect, it } from 'vitest'
import { gateCopy, gateLanguage, loginPage, passwordPage, stoppedPage, waitingPage } from '../src/html.ts'

describe('Gateway entry documents', () => {
  it('uses the CoHarness product brand across account entry and startup pages', () => {
    expect(loginPage()).toContain('<title>登录 - CoHarness</title>')
    expect(loginPage()).toContain('<h1>CoHarness</h1>')
    expect(passwordPage()).toContain('<title>修改密码 - CoHarness</title>')
    expect(waitingPage()).toContain('<title>正在启动 - CoHarness</title>')
  })

  it('renders English gate pages when the language cookie selects it', () => {
    expect(loginPage('', 'en')).toContain('<title>Sign in - CoHarness</title>')
    expect(loginPage('', 'en')).toContain('placeholder="Username"')
    expect(loginPage('', 'en')).toContain('placeholder="Password"')
    expect(passwordPage('', 'en')).toContain('<title>Change password - CoHarness</title>')
    expect(waitingPage('en')).toContain('<title>Starting - CoHarness</title>')
    expect(waitingPage('en')).toContain('Starting your workbench…')
    expect(stoppedPage({ kind: 'user', id: 1 }, 'en')).toContain('<title>Workbench stopped - CoHarness</title>')
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
