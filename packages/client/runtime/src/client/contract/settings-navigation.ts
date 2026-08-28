/** Browser-level request used by feature surfaces to open one settings section. */

/** Detail carried by the settings navigation event. */
export interface SettingsNavigationRequest {
  section?: string
  /** Optional scope requested by a project settings entry point. */
  scope?: 'personal' | 'project'
  projectId?: number
}

/** Ask the settings shell to open, and optionally select, one section.
 * @param section - section id to select, or undefined for the default.
 * @param options - optional project scope and public project id.
 */
export function requestSettingsSection(
  section?: string,
  options: { scope?: 'personal' | 'project'; projectId?: number } = {},
): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<SettingsNavigationRequest>('dsh:settings-open', {
    detail: {
      ...section === undefined ? {} : { section },
      ...options.scope === undefined ? {} : { scope: options.scope },
      ...options.projectId === undefined ? {} : { projectId: options.projectId },
    },
  }))
}

/** Subscribe to settings navigation requests.
 * @param listener - event handler.
 * @returns disposer removing the event listener.
 */
export function onSettingsNavigation(listener: (request: SettingsNavigationRequest) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<SettingsNavigationRequest | undefined>).detail
    listener(detail ?? {})
  }
  window.addEventListener('dsh:settings-open', handler)
  return () => { window.removeEventListener('dsh:settings-open', handler) }
}
