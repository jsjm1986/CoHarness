/** Error raised when a Session format value is malformed. */
export declare class SessionFormatError extends Error {
  readonly name: string
}
/** Error raised when a version has no safe migration path. */
export declare class SessionFormatUnsupportedMigrationError extends SessionFormatError {
  readonly name = 'SessionFormatUnsupportedMigrationError'
}
//# sourceMappingURL=error.d.ts.map
