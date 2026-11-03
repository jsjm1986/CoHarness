/** External execution-registry selection for the managed document mount replay. */
export const name = 'document-mount-authority'
export function apply(ctx) {
  const state = { scope: undefined }
  ctx.effect(() => ctx.provide('fixtureDocumentMountActor', state), 'fixture: actor selection')
  ctx.effect(() => ctx.provide('executionAuthority', { current: () => state.scope }), 'fixture: execution registry')
}
