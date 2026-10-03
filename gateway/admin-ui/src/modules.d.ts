/**
 * The admin program reads workspace sources directly, so type-only imports
 * pull a module's value imports into scope. `install-spec.ts` runs on the
 * host where node types exist; only its declaration matters here.
 */
declare module 'node:path' {
  /** Whether `path` is absolute for the current platform. */
  export function isAbsolute(path: string): boolean
}
