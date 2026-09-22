/** Deterministic association between a release family and its reviewed upstream record. */
/** Version and accepted-baseline fields consumed by record selection. */
export interface UpgradeRecord {
  targetVersion?: string
  releaseVersions?: Record<string, string>
  upstream?: { targetTags?: { commit?: string }[] }
  baseline: { commit: string }
  accepted?: { upstreamCommit: string; localCommit: string }
}

/** Resolve without relying on file order or dates, including an explicit record override.
 * @param records - manifest paths and their parsed contents.
 * @param family - actual publishing family.
 * @param version - verified candidate version.
 * @param upstream - pinned source comparison target.
 * @param explicit - optional record chosen by the release operator.
 * @returns one registered record and its applicable baseline.
 */
export function resolveUpgradeRecord(
  records: readonly { path: string; record: UpgradeRecord }[], family: string, version: string, upstream: string, explicit?: string,
): { path: string; mode: 'alignment' | 'product'; baseCommit: string } {
  if (!/^\d+\.\d+\.\d+(?:[-+.][\w.+-]+)?$/.test(version) || version === '0.0.0') throw new Error('release readiness: placeholder candidate version')
  const versions = records.filter(({ record }) => (family === 'dsh' ? record.targetVersion : record.releaseVersions?.[family]) === version)
  const aligned = versions.filter(({ record }) => record.upstream?.targetTags?.some(target => target.commit === upstream))
  if (versions.length > 0 && aligned.length === 0) throw new Error('release readiness: version records do not own the current upstream target')
  const matches = aligned.length > 0 ? aligned : records.filter(({ record }) => record.accepted?.upstreamCommit === upstream)
  const match = matches[0]
  if (matches.length !== 1 || match === undefined || (explicit !== undefined && match.path !== explicit)) {
    throw new Error('release readiness: zero or multiple applicable upgrade records; explicit selection cannot hide ambiguity')
  }
  const baseCommit = aligned.length > 0 ? match.record.baseline.commit : match.record.accepted?.localCommit
  if (!baseCommit) throw new Error('release readiness: accepted baseline has no local commit')
  return { path: match.path, mode: aligned.length > 0 ? 'alignment' : 'product', baseCommit }
}
