/** Manual, opt-in browser performance sampling; importing or planning does not contact a deployment. */
import { pathToFileURL } from 'node:url'
import { measurementPlan, MeasurementError, parseExistingLatencyConfig, privateText, type ExistingLatencyConfig } from './existing-deployment-latency/config.ts'

/** Validate command arguments before loading any browser or authentication state.
 * @param args - arguments after the executable and script path.
 * @returns the private configuration path and explicit mutation consent.
 */
export function measurementArguments(args: readonly string[]): { configFile: string; execute: boolean } {
  const execute = args.includes('--execute')
  const rest = args.filter(arg => arg !== '--execute')
  if (rest.length !== 2 || rest[0] !== '--config' || !rest[1] || args.filter(arg => arg === '--execute').length > 1) {
    throw new MeasurementError('usage:--config-private-absolute-file-[--execute]')
  }
  return { configFile: rest[1], execute }
}

/** Produce a plan by default. The execution dependency is loaded only after explicit consent.
 * @param args - CLI arguments.
 * @param execute - optional execution adapter for offline verification.
 * @returns a content-free plan or execution summary.
 */
export async function measureExistingDeployment(
  args: readonly string[], execute?: (config: ExistingLatencyConfig) => Promise<unknown>,
): Promise<unknown> {
  const options = measurementArguments(args)
  const config = parseExistingLatencyConfig(JSON.parse(await privateText(options.configFile)))
  if (!options.execute) return measurementPlan(config)
  return (execute ?? (await import('./existing-deployment-latency/runner.ts')).measureDeployment)(config)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await measureExistingDeployment(process.argv.slice(2))
    console.info(JSON.stringify(result, null, 2))
    if (typeof result === 'object' && result !== null && 'complete' in result && result.complete === false) process.exitCode = 1
  }
  catch (error) {
    console.error(error instanceof MeasurementError ? error.code : 'Measurement stopped; inspect the private receipt if execution began.')
    process.exitCode = 1
  }
}
