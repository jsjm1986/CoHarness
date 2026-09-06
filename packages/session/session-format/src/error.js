/** Error raised when a Session format value is malformed. */
export class SessionFormatError extends Error {
    name = 'SessionFormatError';
}
/** Error raised when a version has no safe migration path. */
export class SessionFormatUnsupportedMigrationError extends SessionFormatError {
    name = 'SessionFormatUnsupportedMigrationError';
}
//# sourceMappingURL=error.js.map