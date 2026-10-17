/** Select source or built bootstrap assets in the mounted execution world. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** Deployment-owned Node executable and optional preinstalled built bootstrap. */
export interface LaunchConfig {
  /** Executable in the subprocess world; defaults to the current Node executable. */
  nodeExecutable?: string
  /** Absolute preinstalled built bootstrap in the execution world. */
  bootstrapPath?: string
}

/**
 * Select explicit arguments without inheriting host loader or inspector flags.
 * @param fs - Filesystem mapping host bootstrap assets into the process world.
 * @param config - Optional preinstalled built bootstrap.
 * @param maxMessageBytes - Validated frame and queued-write limit.
 * @param persistent - Select the in-memory REPL bootstrap instead of the one-shot evaluator.
 * @returns Arguments following the resolved Node executable.
 */
export function bootstrapArgs(fs: Pick<FileSystem, 'processPathFromHostPath'>, config: LaunchConfig, maxMessageBytes: number, persistent = false): string[] {
  if (config.bootstrapPath !== undefined) return [config.bootstrapPath, String(maxMessageBytes)]
  if ('pkg' in process) {
    if (persistent) throw new Error('Persistent PTC requires a bootstrapPath')
    return [String(maxMessageBytes)]
  }
  const moduleName = persistent ? 'persistent-process' : 'process'
  const mapped = (path: string): string => {
    const result = fs.processPathFromHostPath(path)
    if (result === undefined) throw new Error(`PTC runtime bootstrap is unavailable in the subprocess execution world: ${path}`)
    return result
  }
  /* v8 ignore next 3 -- built-lib.e2e.ts executes the bundled provider and sibling process.js under plain Node. */
  if (!new URL(import.meta.url).pathname.endsWith('.ts')) {
    return [mapped(fileURLToPath(new URL(`./${moduleName}.js`, import.meta.url))), String(maxMessageBytes)]
  }
  const entry = mapped(fileURLToPath(new URL(`./${moduleName}.ts`, import.meta.url)))
  const subprocess = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess/package.json')))
  const helper = mapped(resolve(subprocess, 'src/control.ts'))
  const main = persistent ? 'runPersistentMain' : 'runNodeMain'
  const source = `const {openInheritedControlChannel}=await import(${JSON.stringify(pathToFileURL(helper).href)});const {${main}}=await import(${JSON.stringify(pathToFileURL(entry).href)});await ${main}(openInheritedControlChannel(),${maxMessageBytes},process);`
  return ['--input-type=module', '--eval', source]
}
