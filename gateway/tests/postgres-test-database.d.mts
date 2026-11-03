/** Test-only PostgreSQL URI selection without opening a connection. */
/**
 * Validate the driver's database; absence permits keyless test execution.
 * @param value - configured URI, or undefined when no test database is supplied.
 * @returns the validated URI or undefined; invalid selections throw before database work.
 */
export declare function postgresTestDatabaseUrl(value: string | undefined): string | undefined
