/** Load a complete private predecessor package without mutating the active source or build. */
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const old = process.env.DSH_AUTO_AUTHORITY_OLD_PACKAGE
if (old !== undefined) registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const path = new URL(resolved.url).pathname
    for (const directory of ['src', 'lib']) {
      const prefix = `/packages/experimental/auto-review/${directory}/`, position = path.lastIndexOf(prefix)
      if (position !== -1) return { shortCircuit: true,
        url: pathToFileURL(join(old, directory, path.slice(position + prefix.length))).href }
    }
    return resolved
  },
})
