/** A report rejected for invalid data or attribution. Retrying the same report will not fix it. */
export class ModelUsageRejection extends Error {
  override name = 'ModelUsageRejection'
}

/**
 * Validate text read from a model usage or registration report.
 * @param value - submitted field.
 * @param name - field name for the rejection.
 * @returns the trimmed, nonempty text.
 */
export function usageText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new ModelUsageRejection(`${name} must be text`)
  const accepted = value.trim()
  if (accepted === '') throw new ModelUsageRejection(`${name} must not be empty`)
  return accepted
}

/**
 * Validate a count submitted in a usage report.
 * @param value - reported count.
 * @param name - field name for the rejection.
 * @returns the accepted count.
 */
export function usageCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ModelUsageRejection(`${name} must be a non-negative safe integer`)
  return value
}
