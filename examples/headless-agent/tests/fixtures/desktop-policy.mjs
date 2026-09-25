/** Select the managed-runtime requirement without replacing the real desktop provider. */
export const name = 'desktop-policy-fixture'
export function apply(ctx) {
  if (process.env.DSH_TEST_MANAGED_DESKTOP === 'true') ctx.provide('executionAuthorityRequired', true)
}
