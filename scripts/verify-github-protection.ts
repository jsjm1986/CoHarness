/** Read-only assertion for the stable required CI verdict; permission failures remain unverified. */
import { execFileSync } from 'node:child_process'

/** Assert that GitHub actually requires the aggregate produced by this repository.
 * @param raw - GitHub required_status_checks response.
 */
export function assertRequiredCiVerdict(raw: unknown): void {
  if (raw === null || typeof raw !== 'object') throw new Error('GitHub protection: missing required status policy')
  const checks = (raw as { checks?: unknown }).checks
  if (!Array.isArray(checks) || !checks.some(check => check !== null && typeof check === 'object'
    && (check as { context?: unknown }).context === 'all checks passed'
    && (check as { app_id?: unknown }).app_id === 15368)) {
    throw new Error('GitHub protection: all checks passed must be required from GitHub Actions (app 15368)')
  }
}

if (import.meta.main) {
  const repository = JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { encoding: 'utf8' })) as {
    nameWithOwner: string
    defaultBranchRef: { name: string }
  }
  try {
    const path = `repos/${repository.nameWithOwner}/branches/${encodeURIComponent(repository.defaultBranchRef.name)}/protection/required_status_checks`
    const response: unknown = JSON.parse(execFileSync('gh', ['api', path], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }))
    assertRequiredCiVerdict(response)
    console.log(JSON.stringify({
      version: 1, repository: repository.nameWithOwner, branch: repository.defaultBranchRef.name, verified: true, response,
    }))
  } catch (error) {
    console.error(`GitHub protection: unverified or invalid policy: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
