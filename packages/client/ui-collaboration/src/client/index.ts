/**
 * Gateway collaboration browser plugin: owns the account-context transport,
 * project scope selector, root-conversation visibility UI, and project
 * read-only composer policy.
 */
import { clientSessionKey } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext, SessionCreateOptions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  CollaborationClient, createBrowserCollaborationTransport, conversationProject,
  type CollaborationVisibility,
} from './collaboration-client.ts'
import {
  ConversationShareAction, type ConversationShareInjected,
} from './ConversationShareAction.tsx'
import { LogoutButton, type LogoutButtonInjected } from './LogoutButton.tsx'
import {
  ReadOnlyComposer, type ProjectReadOnlyMatch,
} from './ReadOnlyComposer.tsx'
import { HeroComputerLabel } from './HeroComputerLabel.tsx'
import { ScopeControl, type ScopeControlInjected } from './ScopeControl.tsx'
import { ComputerControl } from './ComputerControl.tsx'
import { SessionComputerLabel } from './SessionComputerLabel.tsx'
import { SettingsComputerLabel } from './SettingsComputerLabel.tsx'
import { StewardChip, type StewardChipInjected } from './StewardChip.tsx'
import { en, NS, zh, type CollaborationKey } from './locales.ts'

export type {
  CollaborationContext, CollaborationScope, CollaborationSnapshot, ProjectConfiguration,
  CollaborationScopeTarget, CollaborationVisibility, ConversationAccess, ConversationCollaboration,
  ConversationDetail, ConversationParticipant, ProjectInvitation, ProjectMembership, ProjectThemePolicy, UserSummary,
} from './collaboration-client.ts'
export type { ConversationShareActionProps, ConversationShareInjected } from './ConversationShareAction.tsx'
export type { LogoutButtonInjected, LogoutButtonProps } from './LogoutButton.tsx'
export type { ProjectReadOnlyMatch, ReadOnlyComposerProps } from './ReadOnlyComposer.tsx'
export type { ScopeControlInjected, ScopeControlProps } from './ScopeControl.tsx'
export type { ProjectSettingsModalProps } from './ProjectSettingsModal.tsx'
export type { ProjectManagerMode, ProjectManagerModalProps } from './ProjectManagerModal.tsx'
export type { CollaborationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project scope and shared-conversation copy. */
    collaboration: CollaborationKey
  }
}

/** Error raised before a read-only project can create a root session. */
class ProjectReadOnlyError extends Error {
  constructor() {
    super('read-only project members cannot create sessions')
    this.name = 'ProjectReadOnlyError'
  }
}

/** Required services for collaboration slots, session creation, and copy. */
export const inject = ['slots', 'sessions', 'locale', 'deploymentContext']

/**
 * Compose Gateway collaboration behavior and presentation.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-collaboration: dictionaries')

  const collaboration = new CollaborationClient(createBrowserCollaborationTransport({
    canNavigate: () => ctx.get('conversation')?.input.hasUnsavedDrafts() !== true,
  }))
  ctx.on('conversation/document-admission', (sessionId) => {
    const snapshot = collaboration.getSnapshot()
    if (snapshot.context === undefined && snapshot.status === 'unavailable') return
    if (!snapshot.contextVerified || snapshot.context === undefined) return 'deny'
    const target = ctx.sessions.runtimeIdentityFor?.(sessionId)
    const projectId = target?.kind === 'personal' ? undefined : target?.kind === 'project' ? target.projectId : conversationProject(snapshot, sessionId)
    if (projectId !== undefined) {
      const project = snapshot.context.projects.find(item => item.projectId === projectId)
      if (project === undefined || project.mode === 'ro') return 'deny'
    }
    const detail = snapshot.conversations[sessionId]
    if (detail?.status === 'ready' && !detail.detail.access.canWrite) return 'deny'
    return
  })
  const projectUiPolicy = ctx.get('projectUiPolicy')
  ctx.effect(() => {
    void collaboration.load().then(() => collaboration.loadEnvironments())
    const syncPolicy = (): void => {
      const snapshot = collaboration.getSnapshot()
      const context = snapshot.context
      projectUiPolicy?.setVerifiedAccountId(snapshot.contextVerified ? context?.user.id : undefined)
      const scope = context?.scope
      if (context?.environment !== undefined && snapshot.contextVerified && !snapshot.scopeBusy) {
        const location = { runtimeId: context.environment.id, nodeId: context.environment.nodeId,
          ...(context.environment.nodeName === undefined ? {} : { nodeName: context.environment.nodeName }) }
        ctx.sessions.setBaseRuntimeTarget?.(scope?.kind === 'project'
          ? { kind: 'project', projectId: scope.projectId, projectName: scope.projectName, ...location }
          : { kind: 'personal', ...location })
      }
      const full = context?.user.role === 'admin' && context.fullAccess === true
      const auto = context?.autoReviewEligible === true
      projectUiPolicy?.setAccountPermissions(!snapshot.contextVerified || snapshot.scopeBusy ? 'unknown'
        : full ? auto ? 'full-and-auto' : 'full' : auto ? 'auto' : 'standard')
      projectUiPolicy?.setStewardProjects(
        context?.projects.filter(project => project.kind === 'steward').map(project => project.projectId) ?? [],
      )
      if (scope?.kind !== 'project') projectUiPolicy?.set('personal')
      else projectUiPolicy?.set('project', scope.uiThemePolicy ?? 'follow-user', {
        projectId: scope.projectId,
        projectName: scope.projectName,
        canManage: scope.canManage === true,
        steward: scope.steward === true,
      })
    }
    const unsubscribe = collaboration.subscribe(syncPolicy)
    syncPolicy()
    return () => {
      unsubscribe()
      projectUiPolicy?.setVerifiedAccountId(undefined)
      projectUiPolicy?.setAccountPermissions('unknown')
      projectUiPolicy?.setStewardProjects([])
      collaboration.dispose()
    }
  }, 'ui-collaboration: account context')
  ctx.on('connection/will-reset', (initialConnection) => {
    if (!initialConnection) collaboration.invalidateContext()
  })
  ctx.on('connection/reset', (initialConnection) => {
    if (initialConnection === true) {
      if (!collaboration.getSnapshot().contextVerified) void collaboration.load()
      return
    }
    collaboration.invalidateContext()
    void collaboration.refresh().then(() => collaboration.loadEnvironments())
  })

  ctx.on('sessions/prepare-create', async (_options, next): Promise<SessionCreateOptions> => {
    const prepared = await next()
    const snapshot = collaboration.getSnapshot()
    const target = prepared.runtimeTarget
    const id = target?.kind === 'personal' ? undefined : target?.kind === 'project' ? target.projectId
      : snapshot.context?.scope.kind === 'project' ? snapshot.context.scope.projectId : undefined
    if (snapshot.status !== 'ready' || id === undefined) return prepared
    const mode = snapshot.context?.projects.find(project => project.projectId === id)?.mode
      ?? (snapshot.context?.scope.kind === 'project' && snapshot.context.scope.projectId === id ? snapshot.context.scope.mode : undefined)
    if (mode !== 'rw') throw new ProjectReadOnlyError()
    return { ...prepared, visibility: snapshot.context?.scope.kind === 'project' && snapshot.context.scope.projectId === id
      ? snapshot.stagedVisibility : 'project' }
  })

  ctx.on('sessions/confirm-blank-reuse', async (request, next): Promise<boolean> => {
    const reusable = await next()
    if (!reusable) return false
    const snapshot = collaboration.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.context?.scope.kind !== 'project') return true
    const expected = request.options.visibility
    if (expected === undefined) return false
    const id = request.options.runtimeTarget === undefined
      ? request.sessionId : clientSessionKey(request.options.runtimeTarget, request.sessionId)
    return collaboration.matchesConversationVisibility(id, expected)
  })

  const hooks = { collaboration, deployment: ctx.deploymentContext }
  const logoutInjected = (): LogoutButtonInjected => ({ hooks })
  const scopeInjected = (): ScopeControlInjected => ({
    hooks,
    refreshDeployment: () => ctx.deploymentContext.invalidate(),
    switchScope: scope => collaboration.switchScope(scope),
    dismissScopeOffer: () => { collaboration.dismissScopeOffer() },
    dismissScopeError: () => { collaboration.dismissScopeError() },
    toggleFavorite: () => { collaboration.toggleCurrentSpaceFavorite() },
    loadEnvironments: cursor => collaboration.loadEnvironments(cursor),
    chooseEnvironment: () => { window.location.assign('/?environments=1') },
    openEnvironmentTab: (runtimeId) => { window.open(`/?dshRuntime=${encodeURIComponent(runtimeId)}`, '_blank', 'noopener,noreferrer') },
    openEnvironmentPickerTab: () => { window.open('/?environments=1', '_blank', 'noopener,noreferrer') },
    stageVisibility: (visibility: CollaborationVisibility) => { collaboration.stageVisibility(visibility) },
    createProject: (name, nodeId) => collaboration.createProject(name, nodeId),
    listComputers: () => collaboration.listComputers(),
    listInvitations: projectId => collaboration.listInvitations(projectId),
    inviteMember: (projectId, username, mode) => collaboration.inviteMember(projectId, username, mode),
    acceptInvitation: id => collaboration.acceptInvitation(id),
    listUsers: projectId => collaboration.listUsers(projectId),
    getInvitationCount: () => collaboration.getInvitationCount(),
    loadProjectConfiguration: projectId => collaboration.loadProjectConfiguration(projectId),
    setProjectThemePolicy: (projectId, policy) => collaboration.setProjectThemePolicy(projectId, policy),
    listProjectSshTargets: projectId => collaboration.listProjectSshTargets(projectId),
    shareProjectSshTarget: (projectId, targetId, shared) => collaboration.shareProjectSshTarget(projectId, targetId, shared),
  })
  const conversationInjected = (sessionId: SessionId): ConversationShareInjected => ({
    hooks,
    load: () => collaboration.loadConversation(sessionId),
    refresh: () => collaboration.loadConversation(sessionId, { force: true }),
    setVisibility: visibility => collaboration.setVisibility(sessionId, visibility),
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'collaboration-scope',
    order: -20,
    locale: NS,
    inject: scopeInjected,
  }, ScopeControl))

  ctx.slots.inject('shell.mobile.header.context', () => ctx.slots.register({
    name: 'shell.mobile.header.context',
    id: 'collaboration-computer',
    order: 0,
    locale: NS,
    inject: scopeInjected,
  }, ComputerControl))

  ctx.slots.inject('conversation.hero.context', () => ctx.slots.register({
    name: 'conversation.hero.context', id: 'collaboration-blank-computer', order: 0, locale: NS, inject: scopeInjected,
  }, HeroComputerLabel))

  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action', id: 'collaboration-settings-computer', order: -20, locale: NS, inject: scopeInjected,
  }, SettingsComputerLabel))

  ctx.slots.inject('plugins.context', () => ctx.slots.register({
    name: 'plugins.context', id: 'collaboration-plugin-computer', order: -20, locale: NS, inject: scopeInjected,
  }, SettingsComputerLabel))
  ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
    name: 'plugins.detail.actions', id: 'collaboration-plugin-detail-computer', order: -20, locale: NS, inject: scopeInjected,
  }, SettingsComputerLabel))

  ctx.slots.inject('sidebar.settings.action', () => ctx.slots.register({
    name: 'sidebar.settings.action',
    id: 'collaboration-logout',
    order: 0,
    locale: NS,
    inject: logoutInjected,
  }, LogoutButton))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'collaboration-steward-notice',
    order: -10,
    locale: NS,
    inject: (): StewardChipInjected => ({ hooks }),
  }, StewardChip))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'collaboration-sharing',
    order: -20,
    locale: NS,
    inject: conversationInjected,
  }, ConversationShareAction))

  ctx.slots.inject('conversation.session.header.titleMeta', () => ctx.slots.register({
    name: 'conversation.session.header.titleMeta',
    id: 'collaboration-session-computer',
    order: -20,
    locale: NS,
    inject: scopeInjected,
  }, SessionComputerLabel))

  ctx.effect(() => {
    let disposeComposer: (() => void) | undefined
    const reconcile = (): void => {
      const scope = collaboration.getSnapshot().context?.scope
      const snapshot = collaboration.getSnapshot()
      const readOnly = (scope?.kind === 'project' && scope.mode === 'ro') || snapshot.context?.projects.some(project => project.mode === 'ro') === true
      if (readOnly && disposeComposer === undefined) {
        disposeComposer = ctx.slots.inject('conversation.composer', () => ctx.slots.register({
          name: 'conversation.composer',
          priority: 100,
          locale: NS,
          select: (owner: ComposerChainProps): ProjectReadOnlyMatch | null => {
            const current = collaboration.getSnapshot()
            const id = conversationProject(current, owner.session?.sessionId)
            const project = current.context?.projects.find(project => project.projectId === id)
            const mode = project?.mode ?? (current.context?.scope.kind === 'project' && current.context.scope.projectId === id ? current.context.scope.mode : undefined)
            return mode === 'ro' ? 'project-read-only' : null
          },
        }, ReadOnlyComposer))
      } else if (!readOnly && disposeComposer !== undefined) {
        disposeComposer()
        disposeComposer = undefined
      }
    }
    const unsubscribe = collaboration.subscribe(reconcile)
    reconcile()
    return () => {
      unsubscribe()
      disposeComposer?.()
    }
  }, 'ui-collaboration: read-only composer')
}
