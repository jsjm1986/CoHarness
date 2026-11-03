/** Machine-readable output shared by the offline performance diagnostics. */
import { spawn } from 'node:child_process'

/**
 * Write one complete JSON object followed by a physical newline.
 * @param report - Measurements and scope metadata; stdout is reserved for this report.
 */
export function writePerformanceReport(report: Readonly<Record<string, unknown>>): void {
  process.stdout.write(JSON.stringify(report) + '\n')
}

/**
 * Run an owned plain-Node sample with JSON over stdin and join its process and output streams.
 * @param path - absolute diagnostic fixture path; receives --expose-gc and a 60-second deadline.
 * @param input - fixture metadata; secrets stay off command-line arguments.
 * @returns the fixture's JSON report after a successful unsignalled exit.
 */
export async function runPerformanceChild<T>(path: string, input: Readonly<Record<string, unknown>>): Promise<T> {
  const child = spawn(process.execPath, ['--expose-gc', path], {
    stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(60_000),
  })
  let output = '', diagnostic = '', failure: Error | undefined
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic += chunk })
  child.stdin.on('error', error => { failure ??= error })
  const completed = new Promise<void>((resolve, reject) => {
    child.on('error', error => { failure ??= error })
    child.on('close', (code, signal) => {
      if (failure !== undefined) reject(failure)
      else if (signal !== null || code !== 0) reject(new Error(`Performance child failed: ${signal ?? code}\n${diagnostic}`))
      else resolve()
    })
  })
  child.stdin.end(JSON.stringify(input))
  await completed
  return JSON.parse(output) as T
}
