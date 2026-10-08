/** Typed entrypoint for standalone hosted APT preparation. */

/** Serialized hosted-runner APT networking policy. */
export const NETWORK_POLICY: string

/** Configure existing APT directories without changing repository suites or signing keys.
 * @param aptDirectory Existing APT directory or isolated test directory.
 * @returns Paths whose contents change.
 */
export function prepareHostedApt(aptDirectory: string): string[]
