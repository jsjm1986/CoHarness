/** Portable workspace links and runtime payload checks for a standalone Gateway release. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Workspace packages the standalone Gateway's compiled ESM graph imports at
 * runtime, each paired with a built entry file proving the package built.
 */
export const GATEWAY_RUNTIME_PACKAGES: readonly { readonly directory: string; readonly entry: string }[] = [
  { directory: 'native/system/packages/entry', entry: 'lib/flock.js' },
  { directory: 'packages/util/managed-data', entry: 'lib/index.js' },
  { directory: 'packages/util/atomic-write', entry: 'lib/index.js' },
  { directory: 'packages/util/native-command', entry: 'lib/index.js' },
  { directory: 'packages/llm/llm', entry: 'lib/types/discovery.js' },
  { directory: 'packages/session/session-format', entry: 'lib/index.js' },
  { directory: 'packages/core/session', entry: 'lib/index.js' },
  { directory: 'packages/session/session-format-catalog', entry: 'lib/index.js' },
  { directory: 'packages/util/home-paths', entry: 'lib/index.js' },
  { directory: 'packages/util/values', entry: 'lib/index.js' },
  { directory: 'packages/context/resource-budget', entry: 'lib/wire.js' },
  { directory: 'packages/attachment/userdoc', entry: 'lib/index.js' },
  { directory: 'packages/attachment/userdoc-local', entry: 'lib/index.js' },
  { directory: 'packages/attachment/userdoc-gateway', entry: 'lib/protocol.js' },
  { directory: 'packages/host/userdoc-http', entry: 'lib/index.js' },
  { directory: 'vendor/cordis', entry: 'lib/index.js' },
  { directory: 'vendor/schemastery', entry: 'lib/index.mjs' },
]

/**
 * Make the standalone Gateway's compiled ESM graph resolve the workspace
 * packages it imports at runtime. The Gateway is intentionally outside the
 * pnpm workspace, so a clean git-archive release does not get pnpm's usual
 * workspace symlink automatically. The relative link keeps the release
 * self-contained and survives copying the complete release directory.
 * @param root - absolute release root containing the Gateway and workspace packages.
 */
export function ensureGatewayRuntimePackages(root: string): void {
  for (const pkg of GATEWAY_RUNTIME_PACKAGES) {
    const packageRoot = resolve(root, pkg.directory)
    const packageManifest = join(packageRoot, 'package.json')
    const packageEntry = join(packageRoot, pkg.entry)
    if (!existsSync(packageManifest) || !existsSync(packageEntry)) {
      throw new Error(`build-production: Gateway runtime package is incomplete: ${packageRoot}`)
    }
    const manifest = JSON.parse(readFileSync(packageManifest, 'utf8')) as { name?: string }
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      throw new Error(`build-production: Gateway runtime package has no name: ${packageRoot}`)
    }
    const link = resolve(root, 'gateway/node_modules', ...manifest.name.split('/'))
    mkdirSync(dirname(link), { recursive: true })
    const expected = realpathSync(packageRoot)
    const existing = lstatSync(link, { throwIfNoEntry: false })
    if (existing !== undefined) {
      const actual = realpathSync(link)
      if (actual !== expected) {
        throw new Error(`build-production: Gateway runtime package link points to ${actual}, expected ${expected}`)
      }
      continue
    }
    symlinkSync(relative(dirname(link), packageRoot), link, 'dir')
  }
}
/**
 * Verify release-local Gateway links and non-empty runtime entries without mutation.
 * @param root - absolute release root containing the Gateway and workspace packages.
 * @returns whether every required package link and built entry is complete.
 */
export function gatewayRuntimePackageLinksValid(root: string): boolean {
  return GATEWAY_RUNTIME_PACKAGES.every((pkg) => {
    const packageRoot = resolve(root, pkg.directory)
    try {
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: string }
      if (typeof manifest.name !== 'string' || manifest.name === '') return false
      const link = resolve(root, 'gateway/node_modules', ...manifest.name.split('/'))
      const entry = statSync(join(packageRoot, pkg.entry))
      return entry.isFile() && entry.size > 0 && realpathSync(link) === realpathSync(packageRoot)
    } catch {
      return false
    }
  })
}
