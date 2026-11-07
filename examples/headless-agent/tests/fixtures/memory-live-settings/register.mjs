/** Select complete evidence-local old packages without editing the shared source or bundles. */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const baseline = process.env.DSH_MEMORY_OLD_PACKAGES
if (baseline !== undefined) registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const path = new URL(resolved.url).pathname
    for (const name of ['memory-context', 'tool-memory']) {
      if (path.endsWith(`/packages/memory/${name}/lib/index.js`)) {
        return { shortCircuit: true, url: pathToFileURL(join(baseline, `old-${name}/lib/index.js`)).href }
      }
    }
    return resolved
  },
})
