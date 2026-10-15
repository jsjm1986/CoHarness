/** Exposes the shipped Workspace navigation face so the e2e can call startSession with draft options. */
window.__ModuleLoader__.load({
  id: '@fixture/draft-init',
  factory() {
    return {
      inject: ['uiWorkspace'],
      apply(ctx) {
        window.__draftInit = {
          startSession: (workspaceId, options) => ctx.uiWorkspace.startSession(workspaceId, options),
        }
      },
    }
  },
})
