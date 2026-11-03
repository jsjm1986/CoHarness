/** External selection authorization and a non-executing shell capability for the permission lifecycle replay. */
export const name = 'permission-owner-policy'
export function apply(ctx) {
  const state = { pending: undefined }
  ctx.effect(() => ctx.provide('fixturePermissionDecision', state))
  ctx.effect(() => ctx.provide('permissionPresetAuthorization', {
    canSelect: () => true,
    async authorizeSelection() {
      const pending = state.pending
      if (pending === undefined) return
      pending.entered.resolve()
      await pending.release.promise
    },
  }))
  ctx.effect(() => ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('This permission fixture cannot execute shell commands.') },
    run() { throw new Error('This permission fixture cannot execute shell commands.') },
    start() { throw new Error('This permission fixture cannot execute shell commands.') },
  }))
  ctx.effect(() => () => { state.pending?.release.resolve() })
}
