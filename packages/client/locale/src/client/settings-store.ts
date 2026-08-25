/**
 * Language row slot store: a mirror of the locale service snapshot. The
 * plugin's apply-world change listener is the only writer; the row component
 * reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsControlState } from '@deepseek-ai/dsh-client-runtime/client'

/** Standalone store default used before the settings transport is attached. */
const LOCAL_SETTINGS: SettingsControlState = {
  status: 'ready',
  writable: true,
  writableReason: undefined,
  write: { status: 'idle' },
}

/** One selectable locale row (id + self-described label). */
export interface LanguageOptionRow {
  /** Locale id (the setLocale argument). */
  id: string
  /** Display name in its own language (中文 / English). */
  label: string
}

/** Store state mirrored from the locale snapshot. */
export interface LanguageRowState {
  /** Active locale id. */
  active: string
  /** Selectable locales in display order. */
  options: LanguageOptionRow[]
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
  /** Host writability and write status shown by the row. */
  settings: SettingsControlState
}

/** Declared action shape giving the exported factory a stable return type. */
type LanguageRowActions = {
  sync: (
    draft: LanguageRowState,
    active: string,
    options: LanguageOptionRow[],
    revision: number,
    settings?: SettingsControlState,
  ) => void
}

/**
 * Declares the Language row state and write surface.
 * @returns the store handle.
 */
export function createLanguageRowStore(): EngineStoreHandle<LanguageRowState, LanguageRowActions> {
  return defineStore({
    init: (): LanguageRowState => ({
      active: '',
      options: [],
      revision: -1,
      settings: { status: 'loading', writable: false, writableReason: undefined, write: { status: 'idle' } },
    }),
    actions: {
      sync: (
        d,
        active: string,
        options: LanguageOptionRow[],
        revision: number,
        settings: SettingsControlState = LOCAL_SETTINGS,
      ) => {
        if (revision > d.revision) {
          d.active = active
          d.options = options
          d.revision = revision
        }
        d.settings = settings
      },
    },
  })
}
