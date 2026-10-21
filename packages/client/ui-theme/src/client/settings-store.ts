/**
 * Appearance and font row slot stores: mirrors of the theme service
 * snapshot. The plugin's apply-world change listener is the only writer; the
 * row components read via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsControlState } from '@deepseek-ai/dsh-client-runtime/client'
import { DEFAULT_FONT_SIZES, type FontFamilies, type FontSizes, type ThemePreference } from '../theme-settings.ts'

/** Standalone store default used before the settings transport is attached. */
const LOCAL_SETTINGS: SettingsControlState = {
  status: 'ready',
  writable: true,
  writableReason: undefined,
  write: { status: 'idle' },
}

/** Store state mirrored from the theme snapshot. */
export interface AppearanceRowState {
  /** Persisted preference (selection state reads this, never the resolved active theme). */
  preference: ThemePreference
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
  /** Host writability and write status shown by the row. */
  settings: SettingsControlState
  /** Forced project theme, when the project policy overrides this preference. */
  projectOverride?: 'light' | 'dark'
}

/** Declared action shape giving the exported factory a stable return type. */
type AppearanceRowActions = {
  sync: (
    draft: AppearanceRowState,
    preference: ThemePreference,
    revision: number,
    settings?: SettingsControlState,
    projectOverride?: 'light' | 'dark',
  ) => void
}

/**
 * Declares the Appearance row state and write surface.
 * @returns the store handle.
 */
export function createAppearanceRowStore(): EngineStoreHandle<AppearanceRowState, AppearanceRowActions> {
  return defineStore({
    init: (): AppearanceRowState => ({
      preference: 'system',
      revision: -1,
      settings: { status: 'loading', writable: false, writableReason: undefined, write: { status: 'idle' } },
    }),
    actions: {
      sync: (
        d, preference: ThemePreference, revision: number,
        settings: SettingsControlState = LOCAL_SETTINGS,
        projectOverride?: 'light' | 'dark',
      ) => {
        if (revision > d.revision) {
          d.preference = preference
          d.revision = revision
        }
        d.settings = settings
        if (projectOverride === undefined) delete d.projectOverride
        else d.projectOverride = projectOverride
      },
    },
  })
}

/** Store state mirrored from the theme snapshot's fonts (shared by the font-size row and the font settings group). */
export interface FontRowState {
  /** Persisted font sizes in px by role. */
  fontSizes: FontSizes
  /** Persisted normalized font lists by role. */
  fontFamilies: FontFamilies
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type FontRowActions = {
  sync: (draft: FontRowState, fontSizes: FontSizes, fontFamilies: FontFamilies, revision: number) => void
}

/**
 * Declares the font rows' state and write surface.
 * @returns the store handle.
 */
export function createFontRowStore(): EngineStoreHandle<FontRowState, FontRowActions> {
  return defineStore({
    init: (): FontRowState => ({ fontSizes: DEFAULT_FONT_SIZES, fontFamilies: { text: '', code: '', terminal: '' }, revision: -1 }),
    actions: {
      sync: (d, fontSizes: FontSizes, fontFamilies: FontFamilies, revision: number) => {
        if (revision <= d.revision) return
        d.fontSizes = fontSizes
        d.fontFamilies = fontFamilies
        d.revision = revision
      },
    },
  })
}
