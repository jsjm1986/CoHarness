/** Account-owned conversation preferences, with a Host-settings fallback. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for plain Enter while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/** Busy-Enter behaviors accepted at settings and input boundaries. */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of plain Enter while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/** Default preserves Enter-as-Queue for running conversations. */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/** Default maximum transcript content width in pixels. */
export const DEFAULT_CHAT_CONTENT_WIDTH = 748
/** Minimum and maximum user-selectable transcript width. */
export const CHAT_CONTENT_WIDTH_RANGE = { min: 560, max: 1080 } as const
/** Default chat text size in pixels. */
export const DEFAULT_CHAT_FONT_SIZE = 14
/** Supported chat text-size range. */
export const CHAT_FONT_SIZE_RANGE = { min: 12, max: 17 } as const

/** Field carrying the work-details presentation mode. */
export const TRANSCRIPT_VIEW_FIELD = 'transcriptView'

/** Work-details presentation modes a user can choose. */
export const TRANSCRIPT_VIEW_MODES = ['compact', 'standard', 'detailed', 'verbose'] as const

/** Work-details presentation mode. */
export type TranscriptViewMode = typeof TRANSCRIPT_VIEW_MODES[number]

/**
 * Saved value from the two-mode generation of this setting. Read as `detailed`;
 * never offered as a choice and never written back.
 */
export const LEGACY_TRANSCRIPT_VIEW_MODE = 'normal'

/** Saved `expanded` values read as `detailed`, without being offered or written back. */
export const LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE = 'expanded'

/** Every value the durable field accepts: current modes plus legacy saved values. */
const TRANSCRIPT_VIEW_SETTING_VALUES = [
  ...TRANSCRIPT_VIEW_MODES, LEGACY_TRANSCRIPT_VIEW_MODE, LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE,
] as const

/** Default work details for non-Desktop Web clients. */
export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = 'detailed'

/** Performance and usage detail levels accepted by user settings. */
export const PERFORMANCE_USAGE_MODES = ['compact', 'detailed'] as const

/** Performance and usage presentation. */
export type PerformanceUsageMode = typeof PERFORMANCE_USAGE_MODES[number]

/** Preserve detailed accounting for users without an explicit preference. */
export const DEFAULT_PERFORMANCE_USAGE: PerformanceUsageMode = 'detailed'

/** Destinations for ordinary clicks on Chat HTTP(S) links. */
export type LinkOpening = 'sidebar' | 'new-tab'

/** Preserve the built-in browser for users without an explicit preference. */
export const DEFAULT_LINK_OPENING: LinkOpening = 'sidebar'

/** Durable conversation section shared by the Host schema and the browser scope. */
export interface ConversationSettings {
  /** Delivery mode for plain Enter while the addressed agent is busy. */
  busyEnter: BusyEnterBehavior
  /** Persisted transcript width. */
  chatContentWidth: number
  /** Fill the pane instead of clamping to `chatContentWidth`. */
  chatFullWidth?: boolean
  /** Persisted transcript font size. */
  chatFontSize: number
  /** Work-details preference; absence uses the client default, and legacy saved values remain accepted. */
  transcriptView?: TranscriptViewMode | typeof LEGACY_TRANSCRIPT_VIEW_MODE | typeof LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE | null
  /** Detail level for composer statistics and completed-Turn usage. */
  performanceUsage: PerformanceUsageMode
  /** Default destination for Chat HTTP(S) links. */
  linkOpening: LinkOpening
}

/** Durable conversation schema; also the wire envelope the browser scope validates against. */
export const ConversationSettingsSchema: z<ConversationSettings> = z.object({
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
  chatContentWidth: z.number().min(CHAT_CONTENT_WIDTH_RANGE.min).max(CHAT_CONTENT_WIDTH_RANGE.max).default(DEFAULT_CHAT_CONTENT_WIDTH),
  chatFullWidth: z.boolean().default(false),
  chatFontSize: z.number().min(CHAT_FONT_SIZE_RANGE.min).max(CHAT_FONT_SIZE_RANGE.max).default(DEFAULT_CHAT_FONT_SIZE),
  linkOpening: z.union(['sidebar', 'new-tab']).default(DEFAULT_LINK_OPENING),
  performanceUsage: z.union([...PERFORMANCE_USAGE_MODES]).default(DEFAULT_PERFORMANCE_USAGE),
  // Missing and unrecognized modes defer to the client's default.
  [TRANSCRIPT_VIEW_FIELD]: z.union([...TRANSCRIPT_VIEW_SETTING_VALUES]).loose(),
})
