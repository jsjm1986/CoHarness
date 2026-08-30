/** Busy-Enter preference stored in the Host user-settings document. */

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

/** Durable conversation section shared by the Host schema and the browser scope. */
export interface ConversationSettings {
  /** Delivery mode for plain Enter while the addressed agent is busy. */
  busyEnter: BusyEnterBehavior
  /** Persisted transcript width. */
  chatContentWidth: number
  /** Persisted transcript font size. */
  chatFontSize: number
}

/** Durable conversation schema; also the wire envelope the browser scope validates against. */
export const ConversationSettingsSchema: z<ConversationSettings> = z.object({
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
  chatContentWidth: z.number().min(CHAT_CONTENT_WIDTH_RANGE.min).max(CHAT_CONTENT_WIDTH_RANGE.max).default(DEFAULT_CHAT_CONTENT_WIDTH),
  chatFontSize: z.number().min(CHAT_FONT_SIZE_RANGE.min).max(CHAT_FONT_SIZE_RANGE.max).default(DEFAULT_CHAT_FONT_SIZE),
})
