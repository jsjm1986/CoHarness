/** Resolve the complete private predecessor selector package for the unchanged real Gateway scenario. */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const old = process.env.DSH_RECALL_OLD_PACKAGE
if (old !== undefined) registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const path = new URL(resolved.url).pathname
    const prefix = '/packages/memory/memory-context/', position = path.lastIndexOf(prefix)
    if (position !== -1) return { shortCircuit: true,
      url: pathToFileURL(join(old, path.slice(position + prefix.length))).href }
    return resolved
  },
})
