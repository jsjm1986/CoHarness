/** Canonical executable bytes for the immutable plugin combo route. */
import { createHash } from 'node:crypto'
import { clientExecutableSource } from './artifact-revision.ts'

/**
 * Build the ordered factory registrations and their relative map reference.
 * @param bundles - captured client entry bytes in request order.
 * @param sourceMapUrl - map URL relative to the executable response.
 * @returns the script bytes shared by the Host and immutable release reader.
 */
export function renderComboScript(bundles: readonly Buffer[], sourceMapUrl: string): Buffer {
  const registrations = bundles.map(bundle => `${clientExecutableSource(bundle.toString('utf8'))};\n`)
  return Buffer.from(`${registrations.join('')}//# sourceMappingURL=${sourceMapUrl}\n`)
}

/**
 * Identify a group by the ordered revision of each member.
 * @param resources - published package IDs and entry revisions in response order.
 * @returns the short revision carried by the existing combo URL.
 */
export function comboRevision(resources: readonly { id: string; rev: string }[]): string {
  return framedHash('combo', resources.flatMap(resource => [resource.id, resource.rev]))
}

/**
 * Derive a short revision without letting bytes move across field boundaries.
 * @param domain - resource-specific revision namespace.
 * @param parts - consecutive framed fields.
 * @returns the existing twelve-character wire revision.
 */
export function framedHash(domain: string, parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}
