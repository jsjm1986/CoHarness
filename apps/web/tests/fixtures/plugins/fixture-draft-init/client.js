/** Exposes the shipped Workspace navigation face plus the exact reuse predicate the e2e must await. */
window.__ModuleLoader__.load({
  id: '@fixture/draft-init',
  factory() {
    return {
      inject: ['uiWorkspace', 'workspaces', 'sessions'],
      apply(ctx) {
        window.__draftInit = {
          startSession: (workspaceId, options) => ctx.uiWorkspace.startSession(workspaceId, options),
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
