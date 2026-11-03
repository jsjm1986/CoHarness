/**
 * Link the actual governance package before profile peer resolution.
 * @param home - owned Harness home.
 * @returns completion after the profile-local package link exists.
 */
export function prepareGovernance(home: string): Promise<void>
