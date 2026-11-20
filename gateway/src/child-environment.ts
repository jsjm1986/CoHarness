/** Ambient host tooling settings permitted in Gateway runtime, tunnel and control children. */
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|DATABASE_URL|^PGPASSFILE$/i
const GIT_COMMAND_CONFIG = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/i

/**
 * Exclude Gateway configuration, DSH state, credentials and Git command overrides from child inheritance.
 * @returns host tooling settings; the launcher supplies each child's explicit runtime configuration.
 */
export function scrubbedGatewayChildEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !SENSITIVE_ENV.test(entry[0])
    && !GIT_COMMAND_CONFIG.test(entry[0]) && !/^(?:DSH|HGW)_/i.test(entry[0])))
}
