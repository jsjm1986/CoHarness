/** Installed package and dependency bytes used by disaster-recovery execution review. */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { recoveryCanonical, recoveryHash } from './recovery-digest.ts'

interface PackageArtifact {
  readonly digest: string
  readonly bytes: number
  readonly files: number
  readonly dependencies: readonly { name: string; root: string }[]
}
function packageRoot(filename: string): string {
  let root = dirname(realpathSync(filename))
  while (!existsSync(join(root, 'package.json'))) {
    if (dirname(root) === root) throw new Error('Recovery artifacts require an installed package manifest')
    root = dirname(root)
  }
  return root
}

/** Create one inspection's shared cache; no artifact is trusted across inspections or remounts.
 * @returns A digest function covering package files and the installed runtime dependency closure.
 */
export function recoveryArtifactHasher(): (filename: string, dependencyClosure?: boolean, gatewayPolicyProjection?: boolean) => string {
  const packages = new Map<string, PackageArtifact>(), results = new Map<string, string>()
  const failures = new Map<string, unknown>()
  const inspect = (root: string, dependencyClosure: boolean, gatewayPolicyProjection: boolean): PackageArtifact => {
    const key = `${root}:${dependencyClosure}:${gatewayPolicyProjection}`, cached = packages.get(key)
    if (cached !== undefined) return cached
    if (failures.has(key)) throw failures.get(key)
    let bytes = 0, files = 0
    const digest = createHash('sha256')
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (entry.name === 'node_modules' || entry.name === '.git' || /(?:\.map|\.tsbuildinfo|\.d\.[cm]?ts)$/.test(entry.name)) continue
        if (gatewayPolicyProjection && dir === root && !['package.json', 'lib', 'locale', 'cordis.patch.yml', 'cordis.admin.patch.yml'].includes(entry.name)) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile()) {
          files += 1
          const fd = openSync(path, 'r')
          try {
            if (bytes + fstatSync(fd).size > 256 * 1024 * 1024 || files > 32_768) throw new Error('Recovery artifact inspection exceeds its sealed-package limit')
            digest.update(path.slice(root.length))
            const buffer = Buffer.allocUnsafe(64 * 1024)
            for (;;) {
              const count = readSync(fd, buffer, 0, buffer.length, null)
              if (count === 0) break
              bytes += count
              if (bytes > 256 * 1024 * 1024) throw new Error('Recovery artifact inspection exceeds its sealed-package limit')
              digest.update(buffer.subarray(0, count))
            }
          } finally { closeSync(fd) }
        }
        else throw new Error('Recovery package artifacts must be regular files')
      }
    }
    try { walk(root) } catch (error) { failures.set(key, error); throw error }
    const manifestPath = join(root, 'package.json')
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const dependencies: { name: string; root: string }[] = []
    const names = dependencyClosure ? Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).sort() : []
    for (const name of names) {
      const resolver = createRequire(manifestPath)
      try {
        let file: string
        try { file = resolver.resolve(`${name}/package.json`) } catch { file = resolver.resolve(name) }
        dependencies.push({ name, root: packageRoot(file) })
      } catch (error) {
        if (pkg.optionalDependencies?.[name] === undefined && pkg.peerDependenciesMeta?.[name]?.optional !== true) {
          failures.set(key, error)
          throw error
        }
        digest.update(`absent-optional:${name}`)
      }
    }
    const item = { digest: digest.digest('hex'), bytes, files, dependencies }
    packages.set(key, item)
    return item
  }
  return (filename, dependencyClosure = false, gatewayPolicyProjection = false) => {
    const file = realpathSync(filename), key = `${file}:${dependencyClosure}:${gatewayPolicyProjection}`, cached = results.get(key)
    if (cached !== undefined) return cached
    const closure = new Map<string, string>()
    let bytes = 0, files = 0
    const rootOfEntry = packageRoot(file), pending = [rootOfEntry]
    for (let root = pending.pop(); root !== undefined; root = pending.pop()) {
      if (closure.has(root)) continue
      if (closure.size >= 1024) throw new Error('Recovery dependency closure exceeds its package limit')
      const item = inspect(root, dependencyClosure, gatewayPolicyProjection)
      bytes += item.bytes; files += item.files
      if (bytes > 256 * 1024 * 1024 || files > 32_768) throw new Error('Recovery dependency closure exceeds its sealed-package limit')
      closure.set(root, item.digest)
      pending.push(...item.dependencies.map(item => item.root))
    }
    const graph = [...closure].map(([root, digest]) => ({
      digest,
      dependencies: inspect(root, dependencyClosure, gatewayPolicyProjection).dependencies.map(({ name, root: dependencyRoot }) => ({
        name, digest: closure.get(dependencyRoot),
      })),
    }))
    const result = recoveryHash(recoveryCanonical({
      entry: file.slice(rootOfEntry.length),
      packages: [...new Set(graph.map(recoveryCanonical))].sort(),
    }))
    results.set(key, result)
    return result
  }
}
