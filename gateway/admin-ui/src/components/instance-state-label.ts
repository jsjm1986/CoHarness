/** Shared localized process states for badges and native Runtime choices. */
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './users.copy.ts'

/** @param state - reported process state. @returns its existing localized label, retaining unrecognized diagnostics. */
export function instanceStateLabel(state: string): string {
  const t = translateCopy(adminLanguage(), { zh, en })
  const labels: Record<string, string> = {
    multiple: t('stateMultiple'), unassigned: t('stateUnassigned'),
    ready: t('stateReady'), starting: t('stateStarting'),
    stopping: t('stateStopping'), stopped: t('stateStopped'),
  }
  return labels[state] ?? state
}
