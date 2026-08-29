import type { ComposerBarProps } from '../contract/slots.ts'

/** Compact token count for a footer summary. */
export function formatTokens(value: number, t: ComposerBarProps['t']): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('number.thousand', { value: scaled(value / 1_000) })
  return t('number.million', { value: scaled(value / 1_000_000) })
}

/** Exact integer token count with locale-owned digit grouping. */
export function formatExactTokens(value: number, t: ComposerBarProps['t']): string {
  const digits = String(value)
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end))
  }
  return groups.join(t('number.groupSeparator'))
}

function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
  const scale = unitsPerPercent * 100
  const doubledScale = scale * 2
  const quotient = Math.floor(denominator / doubledScale)
  const remainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * quotient + Math.ceil(factor * remainder / doubledScale)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`
}

/** Display a cache-hit percentage without rounding a partial hit to 100%. */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens === 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'
  const rounded = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  const full = decimalPlaces === 0 ? 100 : 1_000
  if (rounded < full) return displayPercentUnits(rounded, decimalPlaces)
  let places = 1
  let scaledGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledGap <= denominatorTens) {
    scaledGap *= 10
    places += 1
  }
  const denominatorOnes = promptTokens % 10
  let loss = 5
  for (let candidate = 1; candidate < 5; candidate += 1) {
    const factor = candidate * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledGap <= threshold) {
      loss = candidate
      break
    }
  }
  return `99.${'9'.repeat(places - 1)}${10 - loss}`
}
