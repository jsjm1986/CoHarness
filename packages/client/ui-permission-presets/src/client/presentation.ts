/** Machine value of the preset that requires an explicit GUI risk gate. */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/**
 * Convert conventional kebab-case preset names into user-facing title case.
 * @param name - host-supplied preset label or key.
 * @returns the title-cased conventional key, or a non-kebab label unchanged.
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Render a permission preset under its product label.
 * @param value - preset machine value.
 * @param name - host-supplied preset name.
 * @returns the Full access product label or the conventional display name.
 */
export function displayPermissionPreset(value: string, name: string): string {
  return value === FULL_ACCESS_PRESET ? 'Full access' : displayPresetName(name)
}

/** Keys for the built-in permission labels shared by settings and composer surfaces. */
export type PermissionPresetCopyKey =
  | 'preset.readOnly'
  | 'preset.workspaceWrite'
  | 'preset.fullAccess'

/**
 * Resolve built-in permission labels through the owning surface's locale.
 * @param value - preset machine value.
 * @param name - host-supplied preset name.
 * @param translate - locale lookup for built-in preset labels.
 * @returns the localized built-in label or the title-cased custom name.
 */
export function localizedPermissionPreset(
  value: string,
  name: string,
  translate: (key: PermissionPresetCopyKey) => string,
): string {
  if (value === 'read-only') return translate('preset.readOnly')
  if (value === 'workspace-write') return translate('preset.workspaceWrite')
  if (value === FULL_ACCESS_PRESET) return translate('preset.fullAccess')
  return displayPresetName(name)
}
