import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'

vi.mock('./pages/UsersPage.tsx', () => ({ UsersPage: () => <h1>用户页面</h1> }))
vi.mock('./pages/ProjectListPage.tsx', () => ({ ProjectListPage: () => <h1>项目页面</h1> }))
vi.mock('./pages/ProjectDetailPage.tsx', () => ({ ProjectDetailPage: () => <h1>项目详情页面</h1> }))
vi.mock('./pages/PluginsPage.tsx', () => ({ PluginsPage: () => <h1>插件页面</h1> }))
vi.mock('./pages/ModelsPage.tsx', () => ({ ModelsPage: () => <h1>模型页面</h1> }))
vi.mock('./pages/UsagePage.tsx', () => ({ UsagePage: () => <h1>用量页面</h1> }))
vi.mock('./pages/AuditPage.tsx', () => ({ AuditPage: () => <h1>审计页面</h1> }))
vi.mock('./pages/ArchivesPage.tsx', () => ({ ArchivesPage: () => <h1>归档页面</h1> }))
vi.mock('./pages/TerminalsPage.tsx', () => ({ TerminalsPage: () => <h1>终端页面</h1> }))
vi.mock('./pages/DesktopsPage.tsx', () => ({ DesktopsPage: () => <h1>桌面页面</h1> }))

describe('App', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/')
  })

  afterEach(() => cleanup())

  it('keeps every destination reachable through the desktop nav or compact mobile menu', async () => {
    render(<App />)
    expect(screen.getByTestId('admin-app')).toBeTruthy()
    const logoutForms = document.querySelectorAll('form[action="/logout"]')
    expect(logoutForms).toHaveLength(2)
    for (const form of logoutForms) expect(form.getAttribute('method')).toBe('post')
    expect(screen.getAllByRole('button', { name: '退出登录' })).toHaveLength(2)
    expect(screen.getAllByText('CoHarness')).toHaveLength(2)
    expect(screen.queryByText('DeepSeek Harness')).toBeNull()
    expect(screen.getAllByRole('navigation', { name: '管理导航' })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: '用户' })).toHaveLength(2)
    const [desktop, mobile] = screen.getAllByRole('navigation', { name: '管理导航' })
    expect(within(desktop!).getAllByRole('link')).toHaveLength(13)
    expect(within(mobile!).getAllByRole('link')).toHaveLength(5)
    expect(screen.getAllByRole('link', { name: '插件' })).toHaveLength(2)
    expect(within(desktop!).getByRole('link', { name: '审计' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '用户页面' })).toBeTruthy()
    await userEvent.click(screen.getAllByRole('link', { name: '项目' })[0]!)
    expect(screen.getByRole('heading', { name: '项目页面' })).toBeTruthy()
    await userEvent.click(within(mobile!).getByRole('button', { name: '更多管理功能' }))
    const menu = within(screen.getByRole('dialog', { name: '更多管理功能' }))
    expect(menu.getAllByRole('link')).toHaveLength(8)
    expect(menu.getByLabelText('界面语言')).toBeTruthy()
    expect(document.documentElement.lang).toBe('zh')
    expect(menu.getByRole('link', { name: '桌面' })).toBeTruthy()
    expect(menu.getByRole('link', { name: '审计' })).toBeTruthy()
    await userEvent.click(menu.getByRole('link', { name: '终端' }))
    expect(screen.getByRole('heading', { name: '终端页面' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '更多管理功能' })).toBeNull()
    expect(within(mobile!).getByRole('button', { name: '更多管理功能' }).classList.contains('active')).toBe(true)
  })

  it('mirrors the persisted language onto the document element and restores it on unmount', () => {
    const previousLang = document.documentElement.lang
    const storage = new Map<string, string>([['coharness-admin-language', 'en']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
    try {
      const view = render(<App />)
      expect(document.documentElement.lang).toBe('en')
      view.unmount()
      expect(document.documentElement.lang).toBe(previousLang)
    } finally {
      vi.unstubAllGlobals()
      document.documentElement.lang = previousLang
    }
  })

  it('redirects /users to the users list', async () => {
    window.history.replaceState({}, '', '/admin/users')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '用户页面' })).toBeTruthy()
    expect(window.location.pathname).toBe('/admin')
  })
})
