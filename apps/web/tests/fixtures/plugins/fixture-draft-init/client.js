/** Exposes the shipped Workspace navigation face plus the exact reuse predicate the e2e must await. */
window.__ModuleLoader__.load({
  id: '@fixture/draft-init',
  factory(require) {
    const { parseClientSessionKey } = require('@deepseek-ai/dsh-client-runtime/client')
    return {
      inject: ['uiWorkspace', 'workspaces', 'sessions'],
      apply(ctx) {
        let initializations = 0
        ctx.on('conversation/draft-initialize', () => { initializations += 1 })
        window.__draftInit = {
          initializations: () => initializations,
          startSession: (workspaceId, options) => ctx.uiWorkspace.startSession(workspaceId, options),
          /**
           * The selection once it lands inside the Workspace this gesture
           * started: an ambient startup restore can publish a foreign Session
           * before the gesture's Session opens, so a plain `selected()` read
           * can capture a Session the test did not start. Membership resolves
           * raw and runtime-qualified ids like `reusable` does.
           */
          selectedIn: (workspaceId) => {
            if (workspaceId === undefined) return undefined
            const workspace = ctx.workspaces.list.getSnapshot().items
              .find(item => item.workspaceId === workspaceId)
            const current = ctx.sessions.list.getSnapshot().current
            if (workspace === undefined || current === undefined) return undefined
            const member = workspace.sessionIds.some(id => id === current
              || String(id).includes(String(current)) || String(current).includes(String(id)))
            return member ? (parseClientSessionKey(current)?.sessionId ?? current) : undefined
          },
          /**
           * Mirrors the connectWorkspace reuse scan verbatim: a blank Session
           * summary whose cwd joins the Workspace path, with Host membership
           * and outside the archive set. Stored selection may carry the raw
           * id or its runtime-qualified key, so identity resolves both forms.
           */
          reusable: (workspaceId, sessionId) => {
            if (workspaceId === undefined || sessionId === undefined) return false
            const state = ctx.workspaces.list.getSnapshot()
            const workspace = state.items.find(item => item.workspaceId === workspaceId)
            const summaries = ctx.sessions.list.getSnapshot().byId
            const summary = summaries[sessionId]
              ?? Object.values(summaries).find(
                entry => String(entry.id).includes(sessionId) || sessionId.includes(String(entry.id)),
              )
            return workspace !== undefined && summary !== undefined && summary.blank === true
              && summary.cwd === workspace.path && workspace.sessionIds.includes(summary.id)
              && !state.archivedSessionIds.includes(summary.id)
          },
        }
      },
    }
  },
})
