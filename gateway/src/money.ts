/** Exact decimal conversion for the Gateway's integer micro-unit amounts. */

/**
 * Format an amount without rounding away stored micro-units.
 * @param value - non-negative safe integer micro-units.
 * @returns a plain decimal amount with six fractional digits.
 */
export function microsToDecimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('monetary value must be a non-negative safe integer')
  return `${String(Math.floor(value / 1_000_000))}.${String(value % 1_000_000).padStart(6, '0')}`
}

/**
 * Convert persisted decimal amounts to the nearest integer micro-unit.
 * @param value - non-negative plain decimal amount.
 * @returns the safe integer amount, rounding half a micro-unit upward.
 */
export function decimalToMicros(value: string | number): number {
  const text = String(value)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (match === null) throw new Error(`invalid non-negative decimal monetary value: ${text}`)
  const whole = Number(match[1])
  const fraction = (match[2] ?? '').padEnd(7, '0')
  let micros = whole * 1_000_000 + Number(fraction.slice(0, 6))
  if (Number(fraction[6]) >= 5) micros += 1
  if (!Number.isSafeInteger(micros)) throw new Error(`monetary value exceeds safe integer range: ${text}`)
  return micros
}
