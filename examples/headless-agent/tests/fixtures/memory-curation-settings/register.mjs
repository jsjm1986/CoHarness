/** Resolve the complete private old curation package for an unchanged real SDK scenario. */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const old = process.env.DSH_CURATION_OLD_PACKAGE
const providerBaseline = process.env.DSH_MEMORY_PROVIDER_OLD_PACKAGES
if (old !== undefined || providerBaseline !== undefined) registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const path = new URL(resolved.url).pathname
    if (providerBaseline !== undefined) {
      for (const name of ['memory', 'memory-context', 'memory-curation']) {
        const prefix = `/packages/memory/${name}/lib/`, position = path.lastIndexOf(prefix)
        if (position !== -1) return { shortCircuit: true,
          url: pathToFileURL(join(providerBaseline, `old-${name}/lib`, path.slice(position + prefix.length))).href }
      }
    }
    if (old !== undefined && path.endsWith('/packages/memory/memory-curation/lib/index.js')) {
      return { shortCircuit: true, url: pathToFileURL(join(old, 'lib/index.js')).href }
    }
    return resolved
  },
})
