/** Resolve the complete private predecessor package without editing the active source or build. */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const old = process.env.DSH_MEMORY_AUTHORITY_OLD_PACKAGE
if (old !== undefined) registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const path = new URL(resolved.url).pathname
    for (const [name, directory] of [['memory-curation', old], ['memory', join(old, '..', 'old-memory')]]) {
      const prefix = `/packages/memory/${name}/lib/`, position = path.lastIndexOf(prefix)
      if (position !== -1) return { shortCircuit: true,
        url: pathToFileURL(join(directory, 'lib', path.slice(position + prefix.length))).href }
    }
    return resolved
  },
})
