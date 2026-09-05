/** State-independent Knip configuration for dependencies owned by generated Typert faces. */
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

const GENERATED_TYPERT_FILES = ['lib/typert.host.js', 'lib/typert.remote-client.js'] as const

interface GeneratedTypertConfigOptions {
  readonly root?: string
  readonly fileExists?: (path: string) => boolean
}

/**
 * Add a workspace-scoped `zod` exception only while generated Typert JavaScript is absent.
 * @param config - checked-in source configuration.
 * @param options - filesystem seam used by the real config and focused tests.
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
    const generatedFileExists = GENERATED_TYPERT_FILES.some(file =>
      fileExists(resolve(root, workspace, file)),
    )
    if (generatedFileExists) continue

    const workspaceConfig = configured.workspaces?.[workspace]
    if (!workspaceConfig) throw new Error(`Knip workspace config is missing: ${workspace}`)
    workspaceConfig.ignoreDependencies = [...new Set([
      ...(workspaceConfig.ignoreDependencies ?? []),
      'zod',
    ])]
  }

  return configured
}

/** Knip configuration resolved for the generated files present in this checkout. */
const config: KnipConfiguration = configureGeneratedTypertDependencies(
  baseConfig as KnipConfiguration,
)

export default config
