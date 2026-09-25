/** Node-local tool exposing bundled interpreters without modifying command resolution. */

import { isAbsolute } from 'node:path'
import schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installPrimaryRuntime, type WorkspaceDependencies } from './primary-runtime.ts'

/** Loader identity of the node-local dependency tool. */
export const name = 'workspace-dependencies'
/** Tool registration and execution-world path mapping must exist before activation. */
export const inject = ['tools', 'fs']

/** Application-selected payload and installation directories. */
export interface Config {
  /** Absolute deployment-owned bundled payload directory. */
  readonly source: string
  /** Absolute private installation directory for the executing runtime. */
  readonly root: string
}

/** Validate deployment-owned paths before registering the tool. */
export const Config: schema<Config> = schema.object({
  source: schema.string().min(1),
  root: schema.string().min(1),
})

/**
 * Register the read-only path query, preparing bundled files on its first invocation.
 * @param ctx - Node-local tool registry owner.
 * @param config - Application payload and fixed installation paths.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.source) || !isAbsolute(config.root)) {
    throw new Error('workspace dependencies: source and root must be absolute')
  }
  let installation: Promise<WorkspaceDependencies> | undefined
  ctx.effect(() => async () => {
    // Tool execution reports installation failures; disposal only waits for filesystem work to settle.
    await installation?.catch(() => undefined)
  })
  ctx.tools.register(defineTool({
    name: 'load_workspace_dependencies',
    description: 'Get absolute paths to bundled Python, Node.js, pnpm, and library directories, plus bundled Python distribution versions. Python includes numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, and XlsxWriter. Use these libraries for Office files unless the user or workspace instructions select another environment. Run pnpm with the returned Node executable and pnpm script path. This does not change PATH or package-manager settings.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          python: { type: 'string', required: true },
          node: { type: 'string', required: true },
          pnpm: { type: 'string', required: true },
          pythonPackages: { type: 'string', required: true },
          nodePackages: { type: 'string', required: true },
          pythonDistributions: { type: 'object', additionalProperties: true, required: true, description: 'Bundled distribution names and versions recorded in runtime.json; excludes user-installed additions.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
    },
    execute: (_args, exec) => {
      const fs = (exec.agent?.ctx ?? ctx).get('fs')
      if (fs === undefined || fs.processPathFromHostPath(config.root) === undefined) {
        throw new Error('workspace dependencies are installed on this runtime node and are unavailable in the current execution target')
      }
      exec.signal.throwIfAborted()
      installation ??= installPrimaryRuntime(config.source, config.root).catch((error: unknown) => {
        installation = undefined
        throw error
      })
      return installation.then(result => {
        exec.signal.throwIfAborted()
        return result
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Load workspace dependencies', kind: 'read' }),
  }))
}
