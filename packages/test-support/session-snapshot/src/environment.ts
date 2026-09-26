/** Child environment policy for keyless replay and explicit recording. */
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

/**
 * Exclude ambient credentials from replay while retaining scenario-owned overrides.
 * @param mode - Explicit snapshot mode; undefined is an ordinary live integration launch.
 * @param overrides - Controlled scenario configuration and source-loader settings.
 * @param parent - Parent environment; defaults to the launching process.
 * @returns Complete child environment suitable for spawn without implicit inheritance.
 */
export function snapshotChildEnvironment(
  mode: string | undefined,
  overrides: NodeJS.ProcessEnv,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (mode !== undefined && !['record', 'replay', 'refresh'].includes(mode)) {
    throw new Error(`invalid snapshot mode: ${JSON.stringify(mode)}`)
  }
  const keyless = mode === 'replay' || mode === 'refresh'
  const inherited = Object.fromEntries(Object.entries(parent).filter(([name]) =>
    !keyless || !SENSITIVE_ENV_PATTERN.test(name)))
  return { ...inherited, ...overrides }
}
