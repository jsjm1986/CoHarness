/** Load a complete private governance predecessor without altering the active package. */
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const old = process.env.DSH_GOVERNANCE_OLD_PACKAGE
if (old !== undefined) registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const path = new URL(resolved.url).pathname
    for (const directory of ['src', 'lib']) {
      const prefix = `/plugins/dsh-model-governance/${directory}/`, position = path.lastIndexOf(prefix)
      if (position !== -1) return { shortCircuit: true,
        url: pathToFileURL(join(old, directory, path.slice(position + prefix.length))).href }
    }
    return resolved
  },
})
