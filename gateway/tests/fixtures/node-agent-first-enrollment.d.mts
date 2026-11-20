/** Execute an isolated source or compiled Node Agent's first-enrollment exchange.
 * @param builtEntry - plain-Node entry; absent uses the source launcher.
 * @returns keyless request, exit and credential persistence observations.
 */
export function firstEnrollment(builtEntry?: string): Promise<{
  exitCode: number | null
  timedOut: boolean
  signal: string | null
  requests: Array<{ method?: string; path?: string }>
  stopped: boolean
  failure?: string
  pendingCredential: boolean
  pendingTicketPreserved: boolean
  identityAssigned: boolean
  secretLogged: boolean
}>
