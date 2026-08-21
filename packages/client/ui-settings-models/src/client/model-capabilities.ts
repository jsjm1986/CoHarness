/** Shared model-capability vocabulary used by the settings editors. */

/** Input modalities the Harness can route into a model request. */
export const MODEL_MODALITIES = ['text', 'image'] as const

/** One supported request modality. */
export type ModelModality = typeof MODEL_MODALITIES[number]

/** Canonical thinking levels understood by the pi-ai adapter. */
export const THINKING_LEVELS = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const

/** One canonical thinking level. */
export type ThinkingLevel = typeof THINKING_LEVELS[number]

/** A per-model effort declaration as stored by `llm-pi-ai`. */
export type ReasoningEfforts = Partial<Record<ThinkingLevel, string | null>> & Record<string, unknown>

/** The three ways a model can describe its reasoning capability. */
export type ReasoningMode = 'inherit' | 'disabled' | 'custom'

/**
 * Whether a value is a plain record suitable for capability fields.
 * @param value - raw value to inspect.
 * @returns whether the value is a non-array object record.
 */
export function isCapabilityRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a model's reasoning declaration without changing its inheritance
 * meaning. An empty object remains a custom declaration so the editor can
 * repair an invalid saved value instead of hiding its controls.
 * @param value - raw `reasoningEfforts` field.
 * @returns the visible editor mode.
 */
export function reasoningModeOf(value: unknown): ReasoningMode {
  if (value === false) return 'disabled'
  if (isCapabilityRecord(value)) return 'custom'
  return 'inherit'
}

/**
 * Copy a declared effort map while preserving the nullable `off` wire
 * spelling. The settings schema remains the authority for unknown keys and
 * invalid values; this helper only supplies the editor controls.
 * @param value - raw `reasoningEfforts` field.
 * @returns a detached map, or an empty map when the field is not a map.
 */
export function reasoningEffortsOf(value: unknown): ReasoningEfforts {
  if (!isCapabilityRecord(value)) return {}
  // Keep fields the editor does not render. The schema normally rejects an
  // unknown key before it reaches this component, but dropping it here would
  // turn a repair into a silent rewrite of the user's declaration.
  return { ...value }
}

/**
 * Return the image-capable part of a model's declared input list.
 * @param value - raw `input` field.
 * @returns whether the declaration names image input.
 */
export function acceptsImages(value: unknown): boolean {
  return Array.isArray(value) && value.includes('image')
}

/**
 * Validate a pi-ai reasoning declaration at the same level as the model-row
 * checks. A declaration must offer at least one level beyond `off`; `off` may
 * be omitted, and only its wire value may be empty (`null`).
 * @param value - raw `reasoningEfforts` field.
 * @returns whether the value is accepted by the adapter's model resolver.
 */
export function validReasoningEfforts(value: unknown): boolean {
  if (value === undefined || value === false) return true
  if (!isCapabilityRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0 || !keys.every(key => (THINKING_LEVELS as readonly string[]).includes(key))) return false
  let hasThinkingLevel = false
  for (const key of keys) {
    const wire = value[key]
    if (wire === null) {
      if (key !== 'off') return false
      continue
    }
    if (typeof wire !== 'string' || wire.length === 0) return false
    if (key !== 'off') hasThinkingLevel = true
  }
  return hasThinkingLevel
}

/**
 * Validate a model input declaration. An empty pi-ai list means inherit, while
 * an explicitly declared list may contain only one copy of each known mode.
 * @param value - raw `input` field.
 * @returns whether the value is valid for the generic provider editor.
 */
export function validInputModalities(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  if (value.some(item => !(MODEL_MODALITIES as readonly unknown[]).includes(item))) return false
  return new Set(value).size === value.length
}

/**
 * Validate the direct DeepSeek catalog's non-empty modality declaration.
 * Unlike pi-ai's `input`, an empty direct-adapter list is invalid because the
 * adapter resolves omission to its text-only default and rejects empty lists.
 * @param value - raw `inputModalities` field.
 * @returns whether the value is accepted by `llm-deepseek`.
 */
export function validDeepSeekInputModalities(value: unknown): boolean {
  if (value === undefined) return true
  return validInputModalities(value) && Array.isArray(value) && value.length > 0
}
