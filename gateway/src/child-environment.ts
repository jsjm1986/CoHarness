/** Ambient host tooling settings permitted in Gateway runtime, tunnel and control children. */
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|DATABASE_URL|^PGPASSFILE$/i

/**
 * Exclude Gateway configuration, DSH state and credential-named variables from child inheritance.
 * @returns host tooling settings; the launcher supplies each child's explicit runtime configuration.
 */
export function scrubbedGatewayChildEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !SENSITIVE_ENV.test(entry[0]) && !/^(?:DSH|HGW)_/i.test(entry[0])))
}
