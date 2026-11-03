/** Deterministic filesystem interference immediately before a real native directory rename. */
import koffi from 'koffi'

/**
 * Forward actual native bindings while interleaving one caller-owned filesystem operation.
 * @template T
 * @param {(source: string, target: string) => Promise<void>} beforeRename - awaited operation before each POSIX or Windows directory rename.
 * @param {() => Promise<T>} operation - work owning this process-wide Koffi override; no other override may overlap it.
 * @returns {Promise<T>} the work result after restoring the exact original loader.
 */
export async function withDirectoryRenameInterleave(beforeRename, operation) {
  const load = koffi.load
  koffi.load = (...args) => {
    const library = load(...args)
    return new Proxy(library, { get(target, key) {
      if (key === 'func') return new Proxy(target.func, { apply(bind, _receiver, declarations) {
        const call = Reflect.apply(bind, library, declarations)
        const syscall = typeof declarations[0] === 'string' && /\bsyscall\(/u.test(declarations[0])
        const directoryRename = typeof declarations[0] === 'string' && /\brenameat(?:2|x_np)\(/u.test(declarations[0])
          || declarations[1] === 'MoveFileExW' || syscall
        if (!directoryRename) return call
        const invoke = call.async.bind(call)
        call.async = (...nativeArgs) => {
          if (syscall && ![276, 316].includes(nativeArgs[0])) return invoke(...nativeArgs)
          // Koffi appends the completion callback after the native arguments.
          const complete = nativeArgs.at(-1)
          const windows = declarations[1] === 'MoveFileExW'
          const offset = syscall ? 1 : 0
          const source = String(nativeArgs[windows ? 0 : 1 + offset]), destination = String(nativeArgs[windows ? 1 : 3 + offset])
          void beforeRename(source, destination).then(() => { invoke(...nativeArgs) }, (error) => { complete(error, -1) })
        }
        return call
      } })
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  try { return await operation() } finally { koffi.load = load }
}
