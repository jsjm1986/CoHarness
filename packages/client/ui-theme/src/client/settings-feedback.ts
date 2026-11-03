/** Settings availability shared by Appearance and font controls. @module */
import type { SettingsControlState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeKey } from './locales.ts'

/**
 * Describe the settings provider's current write status.
 * @param settings - availability and latest write outcome for the bound scope.
 * @returns control availability, localized notice key, and its accessibility role.
 */
export function settingsFeedback(settings: SettingsControlState): {
  disabled: boolean
  notice: ThemeKey | undefined
  role: 'alert' | 'status'
} {
  const blocked = settings.write.status === 'blocked' ? settings.write.reason : undefined
  const reason = blocked ?? settings.writableReason
  const notice: ThemeKey | undefined = settings.write.status === 'error' ? 'appearance.saveFailed'
    : settings.write.status === 'saving' ? 'appearance.saving'
      : reason === 'loading' || settings.status === 'loading' ? 'appearance.loading'
        : reason === 'unavailable' || settings.status === 'unavailable' ? 'appearance.unavailable'
          : reason === 'project' ? 'appearance.projectReadOnly'
            : reason === 'provider' ? 'appearance.providerReadOnly'
              : reason === 'account' ? 'appearance.accountReadOnly'
                : reason === 'organization' ? 'appearance.organizationReadOnly'
                  : reason === 'deployment' ? 'appearance.deploymentReadOnly' : undefined
  return {
    disabled: settings.status !== 'ready' || !settings.writable || settings.write.status === 'saving',
    notice,
    role: settings.write.status === 'error' ? 'alert' : 'status',
  }
}
