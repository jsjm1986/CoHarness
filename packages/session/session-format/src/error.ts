/** Error raised when a Session format value is malformed. */
export class SessionFormatError extends Error {
  override readonly name: string = 'SessionFormatError'
}

/** Error raised when a version has no safe migration path. */
export class SessionFormatUnsupportedMigrationError extends SessionFormatError {
  override readonly name = 'SessionFormatUnsupportedMigrationError'
}
