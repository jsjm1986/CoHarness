/** Lazy loader for the host's stable Node-API system primitives. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Load this host's addon without overriding its platform or libc selection.
 * @param capability - Capability named in unsupported-platform diagnostics.
 * @returns The addon exports; callers select their declared capability interface.
 */
export function loadSystemBinding(capability: 'flock' | 'directory'): unknown {
  const { platform, arch } = process
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(`${capability} is not supported on ${platform}-${arch}`), {
      code: `ERR_${capability.toUpperCase()}_UNSUPPORTED_PLATFORM`, syscall: capability,
    })
  }
  let filename = 'system.node'
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
  return require(join(dirname(manifest), 'bin', filename)) as unknown
}
