/** Select additional pre-merge proofs from the existing workflow inputs and runtime consumers. */
import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import type { CiPrScope } from './ci-pr-scope.ts'
import scopePolicy from './ci-scope-policy.json' with { type: 'json' }

/** Existing proof owners joined by the PR's required summary. */
export type PrProofName = 'releasePack' | 'vendorPack' | 'nativePack' | 'sandbox' | 'provider' | 'piAi' | 'nativeWindows'

/** Provider acceptance scope; unsupported does not disable the corresponding product API. */
export interface ProviderAcceptance {
  deepseek: 'required'
  azureOpenai: 'required' | 'unsupported'
  anthropic: 'required' | 'unsupported'
}

/** Impact on provider verification that is outside the supported acceptance scope. */
export interface UnsupportedPrProof {
  proof: 'piAi'
  status: 'unsupported'
  affected: boolean
  providers: readonly ['azure-openai', 'anthropic']
  reasons: readonly string[]
}

/** True means the owning workflow must succeed; missing environment is not a valid skip. */
export type CiPrProofs = Record<PrProofName, boolean> & {
  reasons: Record<PrProofName, string[]>
  providerAcceptance: ProviderAcceptance
  unsupportedProofs: UnsupportedPrProof[]
}

const WORKFLOW_INPUTS = {
  releasePack: 'release.yml', vendorPack: 'release-vendor.yml', nativePack: 'landlock-run.yml', sandbox: 'sandbox.yml',
} as const
const NAMES: readonly PrProofName[] = ['releasePack', 'vendorPack', 'nativePack', 'sandbox', 'provider', 'piAi', 'nativeWindows']

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the provider acceptance policy without inferring support from available credentials.
 * @param value - Provider acceptance section from the shared CI scope policy.
 * @returns Explicit provider statuses supported by the existing proof owners.
 */
export function parseProviderAcceptance(value: unknown): ProviderAcceptance {
  const keys = ['deepseek', 'azureOpenai', 'anthropic']
  if (!record(value) || Object.keys(value).length !== keys.length
    || !Object.keys(value).every(key => keys.includes(key))) {
    throw new Error('ci-pr-proofs: providerAcceptance must declare exactly deepseek, azureOpenai and anthropic')
  }
  if (value.deepseek !== 'required') throw new Error('ci-pr-proofs: DeepSeek acceptance must remain required')
  if ((value.azureOpenai !== 'required' && value.azureOpenai !== 'unsupported')
    || (value.anthropic !== 'required' && value.anthropic !== 'unsupported')) {
    throw new Error('ci-pr-proofs: providerAcceptance statuses must be required or unsupported')
  }
  if (value.azureOpenai !== value.anthropic) {
    throw new Error('ci-pr-proofs: Azure OpenAI and Anthropic share one proof owner and must have the same acceptance status')
  }
  return { deepseek: value.deepseek, azureOpenai: value.azureOpenai, anthropic: value.anthropic }
}

function workflowPaths(root: string, filename: string): string[] {
  const path = resolve(root, '.github/workflows', filename)
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'))
  const events = record(raw) && record(raw.on) ? raw.on : undefined
  const push = events !== undefined && record(events.push) ? events.push : undefined
  const paths = push?.paths
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((entry: unknown) => typeof entry === 'string')) {
    throw new Error(`ci-pr-proofs: ${filename} must retain its non-empty push.paths input policy`)
  }
  return paths
}

function inTree(path: string, prefix: string): boolean { return path === prefix || path.startsWith(`${prefix}/`) }

function modelInput(path: string): boolean {
  return scopePolicy.modelInputPrefixes.some(prefix => path.startsWith(prefix))
    || scopePolicy.modelInputSuffixes.some(suffix => path.endsWith(suffix))
}

function runtimeInput(path: string): boolean {
  if (modelInput(path) || path === 'vendor/README.md') return true
  if (/^(?:snapshots\/)|(?:^|\/)(?:tests?|fixtures|expected)\//.test(path)) return true
  if (/\.(?:md|mdx)$|\.i18n\.yaml$/.test(path)) return false
  return !scopePolicy.inertPrefixes.some(prefix => path.startsWith(prefix))
}

function matchesWorkflow(path: string, patterns: readonly string[]): boolean {
  let matched = false
  for (const pattern of patterns) {
    if (posix.matchesGlob(path, pattern.startsWith('!') ? pattern.slice(1) : pattern)) matched = !pattern.startsWith('!')
  }
  return matched
}

/**
 * Select required native, provider, kernel and packed-install verification.
 * @param paths - Complete changed paths, including both sides of renames.
 * @param candidate - Candidate CI classification from the shared scope policy.
 * @param root - Repository holding the existing workflow input definitions.
 * @returns Required proofs, unsupported provider impact and their justification. Unknown inputs affect every proof.
 */
export function classifyCiPrProofs(
  paths: readonly string[], candidate: Pick<CiPrScope, 'reason'>, root = resolve(import.meta.dirname, '..'),
): CiPrProofs {
  const providerAcceptance = parseProviderAcceptance(scopePolicy.providerAcceptance)
  const reasons: Record<PrProofName, string[]> = {
    releasePack: [], vendorPack: [], nativePack: [], sandbox: [], provider: [], piAi: [], nativeWindows: [],
  }
  const policies = Object.fromEntries(Object.entries(WORKFLOW_INPUTS).map(([proof, file]) => [proof, workflowPaths(root, file)]))
  const add = (proof: PrProofName, reason: string): void => { reasons[proof].push(reason) }
  const changed = [...new Set(paths.map(path => path.replaceAll('\\', '/')))].sort()
  if (candidate.reason !== 'action-only') for (const path of changed.filter(runtimeInput)) {
    let known = false
    for (const [proof, patterns] of Object.entries(policies)) if (matchesWorkflow(path, patterns)) {
      add(proof as keyof typeof WORKFLOW_INPUTS, `workflow-input:${path}`)
      // The broad dsh publish set owns packaging, not every new package's runtime impact.
      if (proof !== 'releasePack' || !/^(?:packages|apps|plugins)\//.test(path)) known = true
    }
    const shared = /^(?:vendor\/|packages\/(?:api|core|session|sdk|boot|bundle|preset|typert)\/)/.test(path)
      || inTree(path, 'packages/host/apiproxy')
      || /(?:^|\/)[^/]*cordis[^/]*\.ya?ml$/.test(path)
      || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path)
      || /^tsconfig.*\.json$/.test(path)
      || inTree(path, 'apps/cli')
      || modelInput(path)
    if (shared) {
      for (const proof of NAMES) add(proof, `shared-runtime-input:${path}`)
      known = true
    }
    if (/^(?:packages\/(?:sandbox|shell|subprocess|terminal|fs)\/|native\/)/.test(path)) {
      add('nativeWindows', `native-runtime:${path}`)
      if (!path.startsWith('packages/fs/')) add('sandbox', `confinement-consumer:${path}`)
      known = true
    }
    if (/^packages\/(?:llm|credentials|settings|compaction|subagent)\//.test(path)
      || inTree(path, 'plugins/dsh-model-governance')) {
      add('provider', `provider-consumer:${path}`)
      known = true
    }
    if (inTree(path, 'packages/llm/llm-pi-ai') || inTree(path, 'packages/llm/llm')
      || inTree(path, 'packages/credentials') || inTree(path, 'packages/settings')
      || inTree(path, 'plugins/dsh-model-governance')) add('piAi', `protocol-consumer:${path}`)
    if (path === '.github/workflows/e2e.yml') { add('provider', `proof-owner:${path}`); known = true }
    if (path === '.github/workflows/pi-ai-provider-e2e.yml') { add('piAi', `proof-owner:${path}`); known = true }
    const packageGroup = /^packages\/([^/]+)\//.exec(path)?.[1]
    if (packageGroup !== undefined && scopePolicy.scopedPackageGroups.includes(packageGroup)) known = true
    if (['python', 'gateway', 'apps/web', 'apps/android-shell'].some(prefix => inTree(path, prefix))) known = true
    if (!known) for (const proof of NAMES) add(proof, `unknown-impact:${path}`)
  }
  if (changed.length === 0) for (const proof of NAMES) add(proof, 'unknown-or-empty-diff')
  return {
    releasePack: reasons.releasePack.length > 0, vendorPack: reasons.vendorPack.length > 0,
    nativePack: reasons.nativePack.length > 0, sandbox: reasons.sandbox.length > 0,
    provider: reasons.provider.length > 0,
    piAi: providerAcceptance.azureOpenai === 'required' && reasons.piAi.length > 0,
    nativeWindows: reasons.nativeWindows.length > 0,
    reasons,
    providerAcceptance,
    unsupportedProofs: providerAcceptance.azureOpenai === 'unsupported' ? [{
      proof: 'piAi', status: 'unsupported', affected: reasons.piAi.length > 0,
      providers: ['azure-openai', 'anthropic'], reasons: [...reasons.piAi],
    }] : [],
  }
}
