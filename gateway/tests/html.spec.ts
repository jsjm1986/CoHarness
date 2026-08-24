import { describe, expect, it } from 'vitest'
import { loginPage, passwordPage, waitingPage } from '../src/html.ts'

describe('Gateway entry documents', () => {
  it('uses the CoHarness product brand across account entry and startup pages', () => {
    expect(loginPage()).toContain('<title>登录 - CoHarness</title>')
    expect(loginPage()).toContain('<h1>CoHarness</h1>')
    expect(passwordPage()).toContain('<title>修改密码 - CoHarness</title>')
    expect(waitingPage()).toContain('<title>正在启动 - CoHarness</title>')
  })
})
