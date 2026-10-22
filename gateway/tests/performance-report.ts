/** Machine-readable output shared by the offline performance diagnostics. */

/**
 * Write one complete JSON object followed by a physical newline.
 * @param report - Measurements and scope metadata; stdout is reserved for this report.
 */
export function writePerformanceReport(report: Readonly<Record<string, unknown>>): void {
  process.stdout.write(JSON.stringify(report) + '\n')
}
