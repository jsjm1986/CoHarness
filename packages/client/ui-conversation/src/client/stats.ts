import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Compact token count for narrow stats surfaces.
 * @param n - non-negative token count.
 * @returns abbreviated token text.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Context occupancy values projected for the compact context meter. */
export interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
}

/**
 * Approximate context occupancy from the latest pressure projection.
 * @param pressure - session context-pressure projection.
 * @returns occupancy or null until numerator and capacity are known.
 */
export function contextOccupancy(pressure: ContextPressureProjection | undefined): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}
