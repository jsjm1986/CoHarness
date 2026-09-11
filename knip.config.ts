/**
 * Knip configuration for dependencies owned by generated Typert JavaScript.
 *
 * Two reference sources make the published faces visible to Knip: the
 * generated `zod` binding (always ignored, the workspace `project` never
 * includes `lib/`) and external imports in generated `.d.ts` faces that
 * monorepo-internal imports resolve to through `exports` types. The latter
 * report only when the build artifact is present, so the ignore is applied
 * conditionally on the face existing — a static ignore would be flagged as
 * unused on clean checkouts.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { KnipConfiguration } from 'knip'

import baseConfig from './knip.json' with { type: 'json' }

/** Workspaces whose published generated Typert JavaScript imports `zod`. */
export const GENERATED_TYPERT_WORKSPACES = [
  'packages/context/file-reference',
  'packages/context/session-reference',
  'packages/extensions/cordis-host-runner',
  'packages/interaction/commands',
] as const

/**
 * External dependencies imported only by generated Typert JavaScript under
 * `lib/`. Keyed by workspace; `libFile` is the face whose imports report, and
 * `deps` are the package names Knip attributes the imports to (subpaths such
 * as `@deepseek-ai/dsh-session/types` report as `@deepseek-ai/dsh-session`).
 */
export const GENERATED_TYPERT_FACE_DEPENDENCIES = {
  'packages/context/file-reference': {
    libFile: 'lib/typert.remote-client.d.ts',
    deps: ['@deepseek-ai/dsh-session'],
  },
  'packages/test-support/client-runtime': {
    libFile: 'lib/types/sessions.d.ts',
    deps: ['@deepseek-ai/dsh-attachment'],
  },
} as const satisfies Readonly<
  Record<string, { readonly libFile: string; readonly deps: readonly string[] }>
>

/** Filesystem seam for the real config and focused tests. */
export interface GeneratedTypertConfigOptions {
  readonly root?: string
  readonly fileExists?: (filePath: string) => boolean
}

/**
 * @param config - checked-in source configuration.
 * @param options - filesystem seam; `root` is the repository root and
 *   `fileExists` defaults to `existsSync`.
 * @returns a cloned configuration for the current artifact state.
 */
export function configureGeneratedTypertDependencies(
  config: KnipConfiguration,
  options: GeneratedTypertConfigOptions = {},
): KnipConfiguration {
  const root = options.root ?? import.meta.dirname
  const fileExists = options.fileExists ?? existsSync
  const configured = structuredClone(config)

  for (const workspace of GENERATED_TYPERT_WORKSPACES) {
    const workspaceConfig = configured.workspaces?.[workspace]
    if (!workspaceConfig) throw new Error(`Knip workspace config is missing: ${workspace}`)
    workspaceConfig.ignoreDependencies = [...new Set([
      ...(workspaceConfig.ignoreDependencies ?? []),
      'zod',
    ])]
  }
  for (const [workspace, { libFile, deps }] of Object.entries(GENERATED_TYPERT_FACE_DEPENDENCIES)) {
    const workspaceConfig = configured.workspaces?.[workspace]
    if (!workspaceConfig) throw new Error(`Knip workspace config is missing: ${workspace}`)
    if (!fileExists(resolve(root, workspace, libFile))) continue
    workspaceConfig.ignoreDependencies = [...new Set([
      ...(workspaceConfig.ignoreDependencies ?? []),
      ...deps,
    ])]
  }

  return configured
}

/** Knip configuration resolved for the generated files present in this checkout. */
const config: KnipConfiguration = configureGeneratedTypertDependencies(
  baseConfig as KnipConfiguration,
)

export default config
