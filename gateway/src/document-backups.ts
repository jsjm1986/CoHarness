/** Deployment integration for the Gateway-owned document identity inventory. */
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readManagedDataPaths } from '@deepseek-ai/dsh-managed-data'
import { restoreDocumentIdentityBackup, verifyDocumentIdentityBackup } from '@deepseek-ai/dsh-userdoc-local'
import type { DocumentBackupEntry } from '@deepseek-ai/dsh-userdoc-local'
import type { ManagedSnapshot } from './managed-files.ts'
import { DOCUMENT_SCOPE_RECORD_MAX_BYTES, documentRetirementSchema, parseDocumentScopeBinding } from './document-scope-storage.ts'

interface DocumentLocations {
  root: string
  stateRoot: string
  filesRoot: string
}

function locations(snapshot: ManagedSnapshot, filesDir: string): DocumentLocations[] {
  const inventories = snapshot.roots.filter(root => root.owner === 'gateway-document-inventory')
  if (inventories.length > 1 || inventories.some(root => root.kind !== 'file')) throw new Error('Document backup inventory is ambiguous.')
  const inventory = inventories[0]
  if (inventory === undefined) {
    if (snapshot.roots.some(root => root.owner.startsWith('gateway-documents/') || root.owner.startsWith('gateway-document-'))) {
      throw new Error('Document backup inventory is missing.')
    }
    return []
  }
  const member = snapshot.files.find(file => file.sourcePath === inventory.path)
  if (member === undefined) throw new Error('Document backup inventory has no verified contents.')
  const domains = new Map<string, Partial<DocumentLocations>>()
  const retirements = new Map<string, string>()
  for (const row of readManagedDataPaths(join(filesDir, member.member))) {
    if (/^gateway-document-scope\/[a-f0-9]{64}$/u.test(row.owner)) {
      if (row.kind !== 'file') throw new Error('Document scope inventory is invalid.')
      const proof = snapshot.files.find(file => file.sourcePath === row.path)
      if (proof === undefined || proof.sizeBytes > DOCUMENT_SCOPE_RECORD_MAX_BYTES) throw new Error('Document scope ownership has no bounded verified contents.')
      const raw: unknown = JSON.parse(readFileSync(join(filesDir, proof.member), 'utf8'))
      const binding = parseDocumentScopeBinding(raw)
      if (row.owner !== `gateway-document-scope/${createHash('sha256').update(binding.runtimeRoot).digest('hex')}`) {
        throw new Error('Document scope ownership belongs to another directory.')
      }
      continue
    }
    const retired = /^gateway-document-retirement\/([a-f0-9]{64})$/u.exec(row.owner)
    if (retired !== null) {
      if (row.kind !== 'file' || retirements.has(retired[1]!)) throw new Error('Document retirement inventory is invalid.')
      retirements.set(retired[1]!, row.path)
      continue
    }
    const parsed = /^gateway-documents\/([a-f0-9]{64})\/(public|metadata|files)$/u.exec(row.owner)
    if (parsed === null || row.kind !== 'directory') throw new Error('Document backup inventory is invalid.')
    const domain = domains.get(parsed[1]!) ?? {}
    const key = parsed[2] === 'public' ? 'root' : parsed[2] === 'metadata' ? 'stateRoot' : 'filesRoot'
    if (domain[key] !== undefined) throw new Error('Document backup inventory repeats a location.')
    domain[key] = row.path; domains.set(parsed[1]!, domain)
  }
  const active = [...domains].flatMap(([key, domain]) => {
    if (domain.root === undefined || domain.stateRoot === undefined || domain.filesRoot === undefined) {
      throw new Error('Document backup inventory is incomplete.')
    }
    const location = { root: domain.root, stateRoot: domain.stateRoot, filesRoot: domain.filesRoot }
    const retirement = retirements.get(key)
    if (retirement !== undefined) {
      const proof = snapshot.files.find(file => file.sourcePath === retirement)
      if (proof !== undefined) {
        if (proof.sizeBytes > DOCUMENT_SCOPE_RECORD_MAX_BYTES) throw new Error('Document retirement exceeds its record limit.')
        const raw: unknown = JSON.parse(readFileSync(join(filesDir, proof.member), 'utf8'))
        const marker = documentRetirementSchema.parse(raw)
        if (marker.key !== key || marker.root !== domain.root || marker.stateRoot !== domain.stateRoot || marker.filesRoot !== domain.filesRoot
          || marker.initialized && !snapshot.files.some(file => file.sourcePath === join(location.stateRoot, 'metadata.sqlite'))
          || !snapshot.directories.some(directory => directory.path === domain.filesRoot)) {
          throw new Error('Retired document storage is incomplete or belongs to another domain.')
        }
        // Retired stores are byte-retained archives; their former public paths belong to the replacement scope.
        return []
      }
      if (!snapshot.absent.includes(retirement)) throw new Error('Document retirement has no verified contents.')
    }
    return [location]
  }).filter(domain => {
    if (snapshot.absent.includes(domain.stateRoot) && snapshot.absent.includes(domain.filesRoot)) return false
    if (snapshot.absent.includes(domain.stateRoot) && snapshot.directories.some(dir => dir.path === domain.filesRoot)
      && !snapshot.files.some(file => file.sourcePath.startsWith(`${domain.filesRoot}/`))) return false
    return true
  })
  const roots = new Map(snapshot.directories.map(directory => [directory.path, directory.object]))
  const owners = new Set<string>()
  for (const domain of active) {
    const object = roots.get(domain.root)
    const key = object === undefined ? JSON.stringify(['path', domain.root]) : JSON.stringify(['object', object.device, object.inode])
    if (owners.has(key)) throw new Error('Document backup has multiple active owners for one public directory.')
    owners.add(key)
  }
  return active
}

function evidence(snapshot: ManagedSnapshot): DocumentBackupEntry[] {
  return [
    ...snapshot.directories.map(dir => ({ path: dir.path, ...dir.object === undefined ? {} : { object: dir.object } })),
    ...snapshot.files.map(file => ({ path: file.sourcePath, sizeBytes: file.sizeBytes, sha256: file.sha256,
      ...file.object === undefined ? {} : { object: file.object }, ...file.modifiedAt === undefined ? {} : { modifiedAt: file.modifiedAt } })),
  ]
}

/**
 * Validate active identity domains and retired archive membership within a byte-verified managed snapshot.
 * @param snapshot - complete, byte-verified data copied while all writers are quiesced.
 * @param filesDir - immutable snapshot members containing the Gateway-owned inventory.
 * @param signal - deployment data lease lifetime.
 * @returns after active domains have distinct public directories with recoverable file evidence and retired private stores have complete archive membership.
 */
export async function verifyGatewayDocumentBackup(snapshot: ManagedSnapshot, filesDir: string, signal?: AbortSignal): Promise<void> {
  const proof = evidence(snapshot)
  for (const domain of locations(snapshot, filesDir)) await verifyDocumentIdentityBackup(domain, proof, signal)
}

/**
 * Rebind document domains after complete restoration has passed byte verification.
 * @param snapshot - selected immutable backup membership authorized against the protection snapshot.
 * @param filesDir - verified backup members, whose Gateway inventory supplies the complete domain list.
 * @param signal - exclusive restore lease; maintenance remains closed through every rebind.
 * @returns the restored active-domain count; retired stores remain byte archives and failure retains the restore fence for retry.
 */
export async function restoreGatewayDocumentBackup(snapshot: ManagedSnapshot, filesDir: string, signal?: AbortSignal): Promise<number> {
  const domains = locations(snapshot, filesDir), proof = evidence(snapshot)
  for (const domain of domains) await restoreDocumentIdentityBackup(domain, proof, signal)
  return domains.length
}
