/** Required release evidence derives from changed consumers, not a report author's selected subset. */
import { consumerReasons } from '../ci-consumer-relations.ts'
import type { EvidenceEnvironment } from './readiness.ts'

/** One required executed check and the environment in which it is valid. */
export interface ReleaseCheck {
  readonly mode: string
  readonly check: string
  readonly environment: EvidenceEnvironment
}

/** Derive minimum release checks from authoritative candidate inputs.
 * @param paths - local candidate diff, including old and new rename paths.
 * @param family - publication family.
 * @param phase - preflight excludes artifacts still being produced.
 * @returns mandatory checks; manifests may require additional proof but cannot subtract these.
 */
export function requiredReleaseChecks(paths: readonly string[], family: string, phase: 'preflight' | 'publish'): ReleaseCheck[] {
  const result: ReleaseCheck[] = [{ mode: 'ci-linux-primary', check: 'lint', environment: 'source' }]
  const reasons = consumerReasons(paths)
  for (const lane of ['gateway', 'adminUi', 'python'] as const) {
    if (reasons[lane].length > 0 || (lane === 'python' && family === 'python')) {
      const mode = lane === 'adminUi' ? 'admin-ui' : lane === 'python' ? 'python-sdk' : lane
      result.push({ mode, check: mode, environment: 'source' })
      if (lane === 'python') result.push({ mode: 'python-runtime', check: 'python-runtime', environment: 'source' })
    }
  }
  const native = paths.some(path =>
    /^(?:vendor\/|native\/|packages\/(?:sandbox|subprocess|shell)\/|scripts\/build|pnpm-lock\.yaml$)/.test(path))
  if (native) result.push({ mode: 'ci-windows-complete', check: 'build', environment: 'windows-native' })
  if (paths.some(path => /^(?:vendor\/|native\/|packages\/(?:sandbox|shell)\/)/.test(path))) {
    result.push({ mode: 'sandbox-bwrap', check: 'sandbox-bwrap', environment: 'linux-sandbox' },
      { mode: 'sandbox-seatbelt', check: 'sandbox-seatbelt', environment: 'macos-sandbox' })
  }
  if (paths.some(path => /^(?:packages\/(?:llm|core|credentials)\/|plugins\/dsh-model-governance\/)/.test(path))) {
    result.push({ mode: 'real-provider', check: 'real-provider', environment: 'real-provider' })
  }
  if (paths.some(path => /^(?:packages\/llm\/llm-pi-ai\/|plugins\/dsh-model-governance\/)/.test(path))) {
    result.push({ mode: 'real-provider-pi-ai', check: 'real-provider-pi-ai', environment: 'real-provider' })
  }
  if (phase === 'publish') {
    const mode = family === 'python' ? 'python-release' : family === 'native' ? 'native-pack' : 'npm-pack'
    result.push({ mode, check: mode, environment: 'artifact' })
  }
  return result
}
