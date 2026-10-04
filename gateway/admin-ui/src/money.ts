import { decimalToMicros, microsToDecimal } from '../../src/money.ts'

/**
 * Format stored micro-units for an editable decimal input.
 * @param micros - non-negative safe integer micro-units.
 * @returns decimal amount without insignificant trailing zeros.
 */
export function formatCostInput(micros: number): string {
  return microsToDecimal(micros).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Parse an editable decimal amount into integer micro-units.
 * @param text - non-negative decimal amount.
 * @returns rounded safe integer micro-units.
 */
export function parseCostInput(text: string): number {
  return decimalToMicros(text.trim())
}
