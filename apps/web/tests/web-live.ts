/** Explicit selection of real-provider Web checks. */
/**
 * Select explicit live Web verification without letting ambient credentials enable it.
 * @param environment - Requested browser lane and snapshot mode.
 * @returns Whether the real-provider browser lane was explicitly selected.
 */
export function webLiveRequested(environment: NodeJS.ProcessEnv = process.env): boolean {
  const live = environment.DSH_WEB_LIVE
  if (live === undefined || live === '') return false
  if (live !== '1') throw new Error('DSH_WEB_LIVE must be 1 or unset')
  if (environment.DSH_SNAPSHOT !== undefined && environment.DSH_SNAPSHOT !== '') {
    throw new Error('live Web verification cannot run in a snapshot record, replay or refresh lane')
  }
  return true
}

