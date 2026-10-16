// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationShareAction, type ConversationShareActionProps } from '../src/client/ConversationShareAction.tsx'
import { LogoutButton, type LogoutButtonProps } from '../src/client/LogoutButton.tsx'
import logoutCss from '../src/client/LogoutButton.module.css'
import { ReadOnlyComposer, type ReadOnlyComposerProps } from '../src/client/ReadOnlyComposer.tsx'
import { ScopeControl, type ScopeControlProps } from '../src/client/ScopeControl.tsx'
import { StewardChip, type StewardChipProps } from '../src/client/StewardChip.tsx'
import css from '../src/client/ScopeControl.module.css'
import type {
  CollaborationContext, CollaborationSnapshot, ConversationDetail,
} from '../src/client/collaboration-client.ts'
import { zh, type CollaborationKey } from '../src/client/locales.ts'

afterEach(cleanup)

const projectContext: CollaborationContext = {
  user: { id: 7, username: 'lin', displayName: '林工', role: 'member' },
  scope: { kind: 'project', projectId: 9, projectName: '支付重构', mode: 'rw' },
  projects: [
    { projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw' },
    { projectId: 10, name: '审计平台', path: '/srv/audit', mode: 'ro' },
  ],
}

const detail: ConversationDetail = {
  access: {
    sessionId: 'child', rootSessionId: 'root', projectId: 9,
    visibility: 'project', creatorUserId: 7, mode: 'rw',
    canRead: true, canWrite: true, canManage: true,
  },
  conversation: {
    sessionId: 'root', creatorUserId: 7, creatorDisplayName: '林工',
    visibility: 'project', updatedAt: 20,
    participants: [
      { userId: 7, displayName: '林工', contributionCount: 3, lastContributedAt: 10 },
      { userId: 8, displayName: '周工', contributionCount: 1, lastContributedAt: 11 },
    ],
  },
}

function t(key: CollaborationKey, params?: Record<string, string | number>): string {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

function snapshot(partial: Partial<CollaborationSnapshot> = {}): CollaborationSnapshot {
  return {
    status: 'ready',
    context: projectContext,
    stagedVisibility: 'project',
    contextVerified: true,
    scopeBusy: false,
    conversations: {},
    ...partial,
  }
}

function scopeProps(state: CollaborationSnapshot, overrides: Partial<ScopeControlProps> = {}): ScopeControlProps {
  return {
    wide: true,
    useCollaboration: selector => selector(state),
    switchScope: vi.fn().mockResolvedValue(undefined),
    stageVisibility: vi.fn(),
    t,
    useSessions: vi.fn() as never,
    useWorkspaces: vi.fn() as never,
    ...overrides,
  } as ScopeControlProps
}

function conversationProps(
  state: CollaborationSnapshot,
  overrides: Partial<ConversationShareActionProps> = {},
): ConversationShareActionProps {
  return {
    sessionId: 'child' as never,
    useCollaboration: selector => selector(state),
    load: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    setVisibility: vi.fn().mockResolvedValue(undefined),
    t,
    useSession: vi.fn() as never,
    useProjection: vi.fn() as never,
    useSessions: vi.fn() as never,
    useWorkspaces: vi.fn() as never,
    ...overrides,
  } as ConversationShareActionProps
}

function logoutProps(
  state: CollaborationSnapshot,
  overrides: Partial<LogoutButtonProps> = {},
): LogoutButtonProps {
  return {
    wide: true,
    useCollaboration: selector => selector(state),
    t,
    ...overrides,
  } as LogoutButtonProps
}

describe('LogoutButton', () => {
  it('hides outside an authenticated Gateway context', () => {
    const view = render(<LogoutButton {...logoutProps(snapshot({ status: 'unavailable' }))} />)
    expect(view.container.textContent).toBe('')
  })

  it('uses a compact Gateway POST logout action in wide and rail states', () => {
    const view = render(<LogoutButton {...logoutProps(snapshot())} />)
    const form = view.container.querySelector('form')!
    expect(form.getAttribute('method')).toBe('post')
    expect(form.getAttribute('action')).toBe('/logout')
    expect(screen.getByRole('button', { name: '退出登录' }).textContent).toContain('退出')

    view.rerender(<LogoutButton {...logoutProps(snapshot(), { wide: false })} />)
    const button = screen.getByRole('button', { name: '退出登录' })
    expect(button.textContent).toBe('')
    expect(button.className.split(/\s+/)).toContain(logoutCss.rail)
  })

  it('keeps the expanded Settings-side action visually secondary', () => {
    const view = render(<LogoutButton {...logoutProps(snapshot())} />)
    const button = screen.getByRole('button', { name: '退出登录' })
    expect(button.className.split(/\s+/)).toContain(logoutCss.trigger)
    expect(button.querySelector('svg')?.getAttribute('width')).toBe('14')
    expect(view.container.querySelector('form')?.className.split(/\s+/)).toContain(logoutCss.form)
  })
})

describe('ScopeControl', () => {
  it('hides before collaboration is ready and for personal users without projects', () => {
    const loading = render(<ScopeControl {...scopeProps(snapshot({ status: 'loading' }))} />)
    expect(loading.container.textContent).toBe('')
    const noContext = snapshot()
    delete noContext.context
    loading.rerender(<ScopeControl {...scopeProps(noContext)} />)
    expect(loading.container.textContent).toBe('')
    loading.rerender(<ScopeControl {...scopeProps(snapshot({
      context: { ...projectContext, scope: { kind: 'personal' }, projects: [] },
    }))} />)
    expect(loading.container.textContent).toBe('')
  })

  it('switches scopes and stages visibility on the pushed second level', () => {
    const switchScope = vi.fn().mockResolvedValue(undefined)
    const stageVisibility = vi.fn()
    render(<ScopeControl {...scopeProps(snapshot(), { switchScope, stageVisibility })} />)

    const trigger = screen.getByRole('button', { name: '切换个人或项目空间' })
    expect(trigger.textContent).toContain('支付重构')
    // The hero states the scope mode; the trigger pill only flags
    // non-default scopes, so a read-write project carries none.
    expect(trigger.textContent).not.toContain('可编辑')
    fireEvent.click(trigger)
    // Visibility staging lives one level down; the root row shows the value.
    fireEvent.click(screen.getByRole('button', { name: /新对话可见范围/ }))
    fireEvent.click(screen.getByRole('button', { name: /仅自己/ }))
    expect(stageVisibility).toHaveBeenCalledWith('private')
    // Staging keeps the picker open; Escape pops back to the root view.
    expect(screen.getByRole('button', { name: /项目公开/ })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: /新对话可见范围/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /个人空间/ }))
    expect(switchScope).toHaveBeenCalledWith({ kind: 'personal' })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: /审计平台/ }))
    expect(switchScope).toHaveBeenCalledWith({ kind: 'project', projectId: 10 })

    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText(/所有空间/)).toBeNull()
  })

  it('presents the wide surface as a push page: hero, settings group, and member entry', async () => {
    const getInvitationCount = vi.fn().mockResolvedValue({ pending: 2 })
    const loadProjectConfiguration = vi.fn().mockResolvedValue({
      project: { id: 9, name: '支付重构', themePolicy: 'follow-user' },
      canManage: true,
      capabilities: {
        themePolicy: true, runtimeSettings: false, projectModels: false, members: true, filesystem: false,
      },
    })
    render(<ScopeControl {...scopeProps(snapshot(), {
      getInvitationCount,
      listInvitations: vi.fn().mockResolvedValue([]),
      loadProjectConfiguration,
      setProjectThemePolicy: vi.fn(),
    })} />)
    const trigger = screen.getByRole('button', { name: '切换个人或项目空间' })
    fireEvent.click(trigger)
    // The page carries a back control, the settings group, and the roster.
    expect(screen.getByText('空间设置')).toBeTruthy()
    expect(screen.getByText(/所有空间/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByText('空间设置')).toBeNull()
    fireEvent.click(trigger)
    // Pending invitations keep their badge on the member row.
    const invite = await screen.findByRole('button', { name: /邀请与待处理事项/ })
    expect(invite.textContent).toContain('2')
    fireEvent.click(invite)
    expect(await screen.findByText('项目成员与邀请')).toBeTruthy()
  })

  it('filters a growing project roster without hiding personal scope or pinned actions', () => {
    const projects = Array.from({ length: 10 }, (_, index) => ({
      projectId: 100 + index,
      name: `项目 ${index + 1}`,
      path: `/srv/project-${index + 1}`,
      mode: index === 3 ? 'ro' as const : 'rw' as const,
    }))
    projects[3] = { ...projects[3]!, name: '审计平台' }
    const view = render(<ScopeControl {...scopeProps(snapshot({
      context: { ...projectContext, projects },
    }), { createProject: vi.fn() })} />)
    fireEvent.click(screen.getByRole('button', { name: '切换个人或项目空间' }))

    // The wide surface is the push page, not the rail's floating menu.
    const page = screen.getByRole('group', { name: '切换个人或项目空间' })
    expect(page.className.split(/\s+/)).toContain(css.scopePage)
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: '搜索项目空间' })
    expect(search.placeholder).toBe('搜索项目空间')
    expect(screen.getByRole('button', { name: /个人空间/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /新建项目空间/ })).toBeTruthy()

    fireEvent.change(search, { target: { value: '审计' } })
    expect(screen.getByRole('button', { name: /审计平台/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '项目 1' })).toBeNull()

    fireEvent.change(search, { target: { value: '不存在' } })
    expect(screen.getByText('没有匹配的项目空间')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除项目空间搜索' }))
    expect(search.value).toBe('')
    expect(screen.getByRole('button', { name: '项目 1' })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: '切换个人或项目空间' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换个人或项目空间' }))
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: '搜索项目空间' }).value).toBe('')
    view.unmount()
  })

  it('labels the steward space instead of the read-write badge', () => {
    const stewardContext: CollaborationContext = {
      ...projectContext,
      scope: { kind: 'project', projectId: 11, projectName: '维护中枢', mode: 'rw', steward: true },
      projects: [
        ...projectContext.projects,
        { projectId: 11, name: '维护中枢', path: '/srv/steward', mode: 'rw', kind: 'steward' },
      ],
    }
    render(<ScopeControl {...scopeProps(snapshot({ context: stewardContext }))} />)
    const trigger = screen.getByRole('button', { name: '切换个人或项目空间' })
    expect(trigger.textContent).toContain('维护中枢')
    expect(trigger.textContent).toContain('维护')
    expect(trigger.textContent).not.toContain('可编辑')

    fireEvent.click(trigger)
    const stewardItem = screen.getByRole('button', { name: /维护中枢/ })
    expect(stewardItem.textContent).toContain('维护')
    expect(stewardItem.textContent).not.toContain('可编辑')
    // The reserved space leads with the maintenance tile, not a letter tile.
    expect(stewardItem.querySelector('svg')).not.toBeNull()
    expect(stewardItem.querySelector(`span.${css.tileWarn}`)).not.toBeNull()
    const projectItem = screen.getByRole('button', { name: /支付重构/ })
    // The dominant read-write tier stays quiet; only minority tiers flag.
    expect(projectItem.textContent).not.toContain('可编辑')
    expect(projectItem.textContent).not.toContain('只读')
    const tile = projectItem.querySelector(`span.${css.tile}`)
    expect(tile).not.toBeNull()
    expect(tile?.textContent).toBe('支')
  })

  it('flags only the minority grant tier: the dominant tier renders unflagged', () => {
    // Admin-dominant roster: admin rows go quiet, the plain read-write row
    // keeps its flag, and personal/read-only always answer.
    const adminHeavy: CollaborationContext = {
      ...projectContext,
      projects: [
        { projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw', canManage: true },
        { projectId: 10, name: '审计平台', path: '/srv/audit', mode: 'ro' },
        { projectId: 11, name: '提示词组合', path: '/srv/prompt', mode: 'rw', canManage: true },
        { projectId: 12, name: '数据看板', path: '/srv/data', mode: 'rw' },
      ],
    }
    render(<ScopeControl {...scopeProps(snapshot({ context: adminHeavy }))} />)
    fireEvent.click(screen.getByRole('button', { name: '切换个人或项目空间' }))
    expect(screen.getByRole('button', { name: /个人空间/ }).textContent).toContain('个人')
    expect(screen.getByRole('button', { name: /支付重构/ }).textContent).not.toContain('管理员')
    expect(screen.getByRole('button', { name: /提示词组合/ }).textContent).not.toContain('管理员')
    expect(screen.getByRole('button', { name: /审计平台/ }).textContent).toContain('只读')
    expect(screen.getByRole('button', { name: /数据看板/ }).textContent).toContain('可编辑')
  })

  it('flags admin rows when read-write dominates the roster', () => {
    const rwHeavy: CollaborationContext = {
      ...projectContext,
      projects: [
        { projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw', canManage: true },
        { projectId: 12, name: '数据看板', path: '/srv/data', mode: 'rw' },
        { projectId: 13, name: '插件开发', path: '/srv/plugin', mode: 'rw' },
      ],
    }
    render(<ScopeControl {...scopeProps(snapshot({ context: rwHeavy }))} />)
    fireEvent.click(screen.getByRole('button', { name: '切换个人或项目空间' }))
    expect(screen.getByRole('button', { name: /支付重构/ }).textContent).toContain('管理员')
    expect(screen.getByRole('button', { name: /数据看板/ }).textContent).not.toContain('可编辑')
    expect(screen.getByRole('button', { name: /插件开发/ }).textContent).not.toContain('可编辑')
  })

  it('renders a compact rail trigger and omits create visibility for read-only projects', () => {
    const context: CollaborationContext = {
      ...projectContext,
      scope: { kind: 'project', projectId: 10, projectName: '审计平台', mode: 'ro' },
    }
    const view = render(<ScopeControl {...scopeProps(snapshot({ context }))} />)
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).textContent).toContain('只读')
    view.rerender(<ScopeControl {...scopeProps(snapshot({ context }), { wide: false })} />)
    const trigger = screen.getByRole('button', { name: '切换个人或项目空间' })
    expect(trigger.className.split(/\s+/)).toContain(css.rail)
    expect(trigger.textContent).not.toContain('审计平台')
    fireEvent.click(trigger)
    expect(screen.queryByText('新对话可见范围')).toBeNull()
  })

  it('pushes a region-aligned page on wide surfaces: no overlay, level navigation', () => {
    const switchScope = vi.fn().mockResolvedValue(undefined)
    const view = render(<ScopeControl {...scopeProps(snapshot(), { createProject: vi.fn(), switchScope })} />)
    const trigger = screen.getByRole('button', { name: '切换个人或项目空间' })
    // The trigger is a disclosure button, not a menu popup trigger.
    expect(trigger.getAttribute('aria-haspopup')).toBeNull()
    fireEvent.click(trigger)
    // Nothing is portaled: the page renders inside the footer column.
    expect(view.container.querySelector('[role="menu"]')).toBeNull()
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(trigger.getAttribute('aria-controls')).toBe(
      view.container.querySelector(`.${css.scopePage}`)?.id,
    )
    // Root view: hero, the settings group, the roster, and create.
    expect(screen.getByRole('button', { name: /个人空间/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /新对话可见范围/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建项目空间' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /支付重构/ }).getAttribute('aria-current')).toBe('true')
    // The visibility row pushes the second level rather than expanding inline.
    fireEvent.click(screen.getByRole('button', { name: /新对话可见范围/ }))
    expect(screen.getByText('只有创建者可以查看')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新建项目空间' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('button', { name: '新建项目空间' })).toBeTruthy()
    // Tapping a scope row selects it and dismisses the page.
    fireEvent.click(screen.getByRole('button', { name: /审计平台/ }))
    expect(switchScope).toHaveBeenCalledWith({ kind: 'project', projectId: 10 })
    expect(screen.queryByRole('button', { name: '新建项目空间' })).toBeNull()
    // The head toggles the same page back open at its root view.
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: '新建项目空间' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /新对话可见范围/ })).toBeTruthy()
  })

  it('keeps project settings discoverable for a read-only member and explains the owner boundary', async () => {
    const loadProjectConfiguration = vi.fn().mockResolvedValue({
      project: { id: 9, name: '支付重构', themePolicy: 'follow-user' },
      canManage: false,
      capabilities: {
        themePolicy: false, runtimeSettings: false, projectModels: false, members: false, filesystem: false,
      },
    })
    const setProjectThemePolicy = vi.fn()
    render(<ScopeControl {...scopeProps(snapshot(), {
      loadProjectConfiguration,
      setProjectThemePolicy,
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '切换个人或项目空间' }))
    fireEvent.click(screen.getByRole('button', { name: '项目设置' }))
    expect(await screen.findByText('只有项目 owner 或组织管理员可以修改项目策略。')).toBeTruthy()
    expect(loadProjectConfiguration).toHaveBeenCalledWith(9)
    expect(setProjectThemePolicy).not.toHaveBeenCalled()
  })

  it('shows switching and failure states on the trigger', () => {
    const view = render(<ScopeControl {...scopeProps(snapshot({ scopeBusy: true }))} />)
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).getAttribute('title')).toBe('正在切换空间')
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<ScopeControl {...scopeProps(snapshot({ scopeError: 'switch-failed' }))} />)
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).getAttribute('title')).toBe('空间切换失败，请重试')
  })

  it('shows a non-dismissible target and progress status while switching', () => {
    vi.useFakeTimers()
    try {
      render(<ScopeControl {...scopeProps(snapshot({
        scopeBusy: true,
        scopeTarget: { kind: 'project', projectId: 10, projectName: '审计平台' },
      }))} />)
      expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
      expect(screen.getByText('正在进入「审计平台」')).toBeTruthy()
      expect(screen.getByText('正在提交空间切换请求')).toBeTruthy()

      act(() => { vi.advanceTimersByTime(3_500) })
      expect(screen.getByText('服务就绪后将自动连接工作台')).toBeTruthy()
      expect(screen.getByText('已等待 3 秒')).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.getByRole('status')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows personal scope when projects remain available', () => {
    render(<ScopeControl {...scopeProps(snapshot({
      context: { ...projectContext, scope: { kind: 'personal' } },
    }))} />)
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).textContent).toContain('个人空间')
  })
})

describe('ConversationShareAction', () => {
  it('does not render or load in personal scope', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const view = render(<ConversationShareAction {...conversationProps(snapshot({
      context: { ...projectContext, scope: { kind: 'personal' } },
    }), { load })} />)
    expect(view.container.textContent).toBe('')
    expect(load).not.toHaveBeenCalled()
  })

  it('renders loading and retry states while requesting collaboration detail', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const view = render(<ConversationShareAction {...conversationProps(snapshot(), { load })} />)
    expect(screen.getByRole('button', { name: '管理对话共享范围' }).hasAttribute('disabled')).toBe(true)
    expect(load).toHaveBeenCalledOnce()

    view.rerender(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'error', saving: false, error: 'load-failed' } },
    }), { load })} />)
    const retry = screen.getByRole('button', { name: '管理对话共享范围' })
    expect(retry.hasAttribute('disabled')).toBe(false)
    fireEvent.click(retry)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shows visibility, creator, participants, and sends a visibility update', () => {
    const setVisibility = vi.fn().mockResolvedValue(undefined)
    const refresh = vi.fn().mockResolvedValue(undefined)
    render(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail } },
    }), { refresh, setVisibility })} />)
    const trigger = screen.getByRole('button', { name: '管理对话共享范围' })
    expect(trigger.textContent).toContain('项目公开')
    expect(trigger.textContent).toContain('2')
    expect(screen.queryByText('参与者（2）')).toBeNull()
    fireEvent.click(trigger)
    expect(refresh).toHaveBeenCalledOnce()
    expect(screen.getByText('创建者：林工')).toBeTruthy()
    expect(screen.getAllByText('参与者（2）')).toHaveLength(1)
    expect(screen.getAllByText('3 次参与')).toHaveLength(1)
    expect(screen.getAllByText('1 次参与')).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: /仅自己/ }))
    expect(setVisibility).toHaveBeenCalledWith('private')
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('创建者：林工')).toBeNull()
  })

  it('refreshes participant detail when the current conversation gains a node', () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const session = { tailSeq: undefined as number | undefined }
    const props = conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail } },
    }), {
      refresh,
      useSession: selector => selector({
        nodes: session.tailSeq === undefined ? [] : [{ seq: session.tailSeq }],
      } as never),
    })
    const view = render(<ConversationShareAction {...props} />)
    expect(refresh).not.toHaveBeenCalled()
    session.tailSeq = 8
    view.rerender(<ConversationShareAction {...props} />)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('shows creator-only, empty-participant, permission, and update error states', () => {
    const privateDetail: ConversationDetail = {
      access: { ...detail.access, visibility: 'private', canManage: false },
      conversation: {
        ...detail.conversation!, visibility: 'private', participants: [],
      },
    }
    const view = render(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail: privateDetail } },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    expect(screen.getAllByText('暂无其他参与者').length).toBeGreaterThan(0)
    expect(screen.getByText('只有创建者可以更改共享范围')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /项目公开/ }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    view.rerender(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail, error: 'visibility-locked' } },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    expect(screen.getByText('已有其他成员参与，不能改为仅自己')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    view.rerender(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail, error: 'update-failed' } },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    expect(screen.getByText('共享范围更新失败，请重试')).toBeTruthy()
  })

  it('falls back to creator id when root metadata is absent and disables changes while saving', () => {
    render(<ConversationShareAction {...conversationProps(snapshot({
      conversations: {
        child: { status: 'ready', saving: true, detail: { ...detail, conversation: null } },
      },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    expect(screen.getByText('创建者：7')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /项目公开/ }).hasAttribute('disabled')).toBe(true)
  })
})

describe('ReadOnlyComposer', () => {
  it('renders the project read-only state', () => {
    const props = {
      matched: 'project-read-only', t,
      sessionId: 'child', useSession: vi.fn(), useProjection: vi.fn(),
      useSessions: vi.fn(), useWorkspaces: vi.fn(), interactions: [], session: undefined,
    } as unknown as ReadOnlyComposerProps
    render(<ReadOnlyComposer {...props} />)
    expect(screen.getByRole('status').textContent).toContain('只读项目')
    expect(screen.getByRole('status').textContent).toContain('当前成员权限不允许修改此对话。')
  })
})

describe('StewardChip', () => {
  function chipProps(state: CollaborationSnapshot): StewardChipProps {
    return {
      sessionId: 'child',
      useSession: vi.fn(), useSessions: vi.fn(), useWorkspaces: vi.fn(),
      useCollaboration: <T,>(selector: (snapshot: CollaborationSnapshot) => T): T => selector(state),
      t,
    } as StewardChipProps
  }

  it('marks the audited maintenance channel inside steward scope', () => {
    const stewardContext: CollaborationContext = {
      ...projectContext,
      scope: { kind: 'project', projectId: 11, projectName: '维护中枢', mode: 'rw', steward: true },
    }
    render(<StewardChip {...chipProps(snapshot({ context: stewardContext }))} />)
    const chip = screen.getByRole('button', { name: '维护通道' })
    expect(chip.querySelector('svg')).not.toBeNull()
  })

  it('reveals the full audit and approval clause from the chip', async () => {
    const stewardContext: CollaborationContext = {
      ...projectContext,
      scope: { kind: 'project', projectId: 11, projectName: '维护中枢', mode: 'rw', steward: true },
    }
    render(<StewardChip {...chipProps(snapshot({ context: stewardContext }))} />)
    fireEvent.click(screen.getByRole('button', { name: '维护通道' }))
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('常驻维护通道')
    expect(tip.textContent).toContain('全部操作留痕审计')
    expect(tip.textContent).toContain('写语句需当场批准')
  })

  it('renders nothing in an ordinary project scope', () => {
    const view = render(<StewardChip {...chipProps(snapshot())} />)
    expect(view.container.childElementCount).toBe(0)
    expect(screen.queryByRole('button', { name: '维护通道' })).toBeNull()
  })

  it('renders nothing while the account context is loading', () => {
    const loading = snapshot({ contextVerified: false })
    delete loading.context
    const view = render(<StewardChip {...chipProps(loading)} />)
    expect(view.container.childElementCount).toBe(0)
  })
})
