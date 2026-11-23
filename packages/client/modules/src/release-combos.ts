/** Read executable combo candidates solely from a verified, immutable installation. */
import { createHash } from 'node:crypto'
import { glob, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { clientContentRevision } from './artifact-revision.ts'
import { comboRevision, renderComboScript } from './combo-script.ts'

/** The Host echoes a digest only when the requested published script has those exact bytes. */
export const RELEASE_COMBO_DIGEST_HEADER = 'x-dsh-release-combo-sha256'

const COMBO_TARGET = /^\/plugins\/combo\.js\?\?([^?&#]+)&rev=([0-9a-f]{12})$/u
const WORKSPACE_ENTRY = /^(@deepseek-ai\/dsh-[a-z0-9-]+)\/client\.js$/u
const BYTE_BUDGET = 8 * 1024 * 1024
const ENTRY_BUDGET = 64
const MAX_CONCURRENT_READS = 2

/** Locally reconstructed bytes and their complete executable digest. */
export interface ReleaseComboCandidate {
  readonly sha256: string
  readonly body: Buffer
}

/** Only lexical paths resolved within a canonical package directory qualify. */
function inside(parent: string, target: string): boolean {
  const path = relative(parent, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Index only the release's built-in packages, without resolving any Runtime-local modules. */
async function packagedClients(root: string): Promise<Map<string, string>> {
  const clients = new Map<string, string>()
  for await (const file of glob('packages/*/*/package.json', { cwd: root })) {
    const path = await realpath(join(root, file))
    if (!inside(join(root, 'packages'), path)) continue
    const manifest: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('name' in manifest)
      || typeof manifest.name !== 'string' || !WORKSPACE_ENTRY.test(`${manifest.name}/client.js`)) continue
    const client = (manifest as { exports?: { './client'?: string | { default?: string } } }).exports?.['./client']
    if ((typeof client === 'string' ? client : client?.default) !== './lib/client.js') continue
    if (clients.has(manifest.name)) throw new Error('Client release contains a repeated package name')
    clients.set(manifest.name, dirname(path))
  }
  return clients
}

/**
 * Open a bounded reader for an already verified release's built-in scripts.
 * A result is a byte candidate only. Its publication and read authority must
 * still come from the exact selected Runtime.
 * @param releaseRoot - canonical immutable installation root.
 * @returns a reader of exact versioned script targets. Inapplicable and unavailable candidates resolve to undefined.
 */
export function openReleaseComboReader(releaseRoot: string): (target: string) => Promise<ReleaseComboCandidate | undefined> {
  let index: Promise<Map<string, string>> | undefined
  const retained = new Map<string, ReleaseComboCandidate>()
  const pending = new Map<string, Promise<ReleaseComboCandidate | undefined>>()
  let retainedBytes = 0

  const materialize = async (resources: string, rev: string): Promise<ReleaseComboCandidate | undefined> => {
    const names = resources.split(',').map(resource => WORKSPACE_ENTRY.exec(resource)?.[1])
    if (!names.every((name): name is string => name !== undefined) || new Set(names).size !== names.length) return undefined
    const clients = await (index ??= packagedClients(releaseRoot))
    const rows: { id: string; rev: string; bytes: Buffer }[] = []
    let available = BYTE_BUDGET
    for (const name of names) {
      const directory = clients.get(name)
      if (directory === undefined) return undefined
      const file = await realpath(join(directory, 'lib', 'client.js'))
      if (!inside(directory, file)) return undefined
      const info = await stat(file)
      if (!info.isFile() || info.size <= 0 || info.size > available) return undefined
      const bytes = await readFile(file)
      if (bytes.byteLength !== info.size) return undefined
      const revision = clientContentRevision(bytes)
      if (revision === undefined) return undefined
      rows.push({ id: name, rev: revision, bytes })
      available -= bytes.byteLength
    }
    if ((rows.length !== 1 || rows[0]?.rev !== rev) && comboRevision(rows) !== rev) return undefined
    const map = `combo.js??${resources.split(',').map(resource => `${resource}.map`).join(',')}&rev=${rev}`
    const body = renderComboScript(rows.map(row => row.bytes), map)
    return body.byteLength <= BYTE_BUDGET ? { body, sha256: createHash('sha256').update(body).digest('hex') } : undefined
  }

  return async (target) => {
    if (target.length > 3 * 1024) return undefined
    const [, resources, revision] = COMBO_TARGET.exec(target) ?? []
    if (resources === undefined || revision === undefined) return undefined
    const cached = retained.get(target)
    if (cached !== undefined) {
      retained.delete(target)
      retained.set(target, cached)
      return cached
    }
    const active = pending.get(target)
    if (active !== undefined) return active
    if (pending.size >= MAX_CONCURRENT_READS) return undefined
    const build = materialize(resources, revision).then((result) => {
      if (result === undefined) return undefined
      retained.set(target, result)
      retainedBytes += result.body.byteLength
      for (const [oldTarget, old] of retained) {
        if (retainedBytes <= BYTE_BUDGET && retained.size <= ENTRY_BUDGET) break
        retained.delete(oldTarget)
        retainedBytes -= old.body.byteLength
      }
      return result
    }).catch(() => {
      // Unavailable or invalid installation artifacts leave owning-node delivery available.
      return undefined
    }).finally(() => { pending.delete(target) })
    pending.set(target, build)
    return build
  }
}
