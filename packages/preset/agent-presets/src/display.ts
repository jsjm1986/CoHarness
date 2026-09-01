/**
 * Browser-safe display resolution for preset roster rows. Built-in ids use the
 * active UI dictionary; user-authored metadata remains literal so a user name
 * is never mistaken for translatable product copy.
 * @module @deepseek-ai/dsh-agent-presets/display
 */

/** Dictionary keys carrying built-in preset display copy. */
export type BuiltInPresetCopyKey =
  | 'presetStandardName'
  | 'presetStandardDescription'
  | 'presetCodeName'
  | 'presetCodeDescription'
  | 'presetMinimalName'
  | 'presetMinimalDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'

/** Preset fields needed by the display fold. */
export interface PresetDisplaySource {
  /** Stable preset id. */
  readonly id: string
  /** Whether the deployment ships the preset or the user owns it. */
  readonly trust: 'system' | 'user'
  /** Unlocalized metadata name. */
  readonly name?: string
  /** Unlocalized metadata description. */
  readonly description?: string
}

/** Localized copy returned to a browser surface. */
export interface PresetDisplayText {
  readonly name: string
  readonly description?: string
}

interface PresetLocaleKeys {
  readonly name: BuiltInPresetCopyKey
  readonly description: BuiltInPresetCopyKey
}

const BUILT_IN_KEYS: Readonly<Partial<Record<string, PresetLocaleKeys>>> = {
  standard: { name: 'presetStandardName', description: 'presetStandardDescription' },
  code: { name: 'presetCodeName', description: 'presetCodeDescription' },
  minimal: { name: 'presetMinimalName', description: 'presetMinimalDescription' },
  cordis: { name: 'presetCordisName', description: 'presetCordisDescription' },
}

/**
 * Resolve one preset's visible copy for the active locale.
 * @param preset - stable id and unlocalized metadata for one preset.
 * @param translate - locale lookup for built-in preset copy.
 * @returns the visible name and optional description.
 */
export function presetDisplayText(
  preset: PresetDisplaySource,
  translate: (key: BuiltInPresetCopyKey) => string,
): PresetDisplayText {
  const keys = preset.trust === 'system' ? BUILT_IN_KEYS[preset.id] : undefined
  if (keys !== undefined) return { name: translate(keys.name), description: translate(keys.description) }
  return {
    name: preset.name ?? preset.id,
    ...preset.description === undefined ? {} : { description: preset.description },
  }
}

/**
 * Resolve only the visible name for callers that do not render descriptions.
 * @param preset - stable id and unlocalized metadata for one preset.
 * @param translate - locale lookup for built-in preset copy.
 * @returns the visible preset name.
 */
export function presetDisplayName(
  preset: PresetDisplaySource,
  translate: (key: BuiltInPresetCopyKey) => string,
): string {
  return presetDisplayText(preset, translate).name
}
