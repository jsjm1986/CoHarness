/** Durable plugin desired state: PostgreSQL truth, profile files as the runtime projection. */
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import type { QueryResult, QueryResultRow } from 'pg'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import type { RuntimeTarget } from './instances.ts'

/** One manager-owned patch row: literal enablement for one composition id. */
export interface PluginStateEntry { id: string; name?: string; disabled: boolean }
/** The desired profile composition persisted in `harness.plugin_states`. */
export interface PluginDesiredState { entries: PluginStateEntry[]; bundles: string[] }
/** Current desired state with its optimistic-concurrency marker; `state` is null while no row exists. */
export interface PluginStateSnapshot { revision: string; state: PluginDesiredState | null }
/** One organization's saved desired-state row as the administrator overview lists it. */
export interface PluginStateOverviewRow {
  target: RuntimeTarget & { label: string }
  entries: number
  disabled: number
  bundles: number
  revision: string
  updatedAt: string
  live: boolean
  generation: number | null
}
/** A state request was invalid, addressed a missing owner, or carried a stale revision. */
export class PluginStateError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 500, message: string) { super(message) }
}

/** The instance profile directory every managed runtime launches. */
export const INSTANCE_PROFILE = 'web'

interface InternalOwner { organizationId: string; runtimeId: RuntimeId; userId?: string; projectId?: string }

interface Querier {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

function ownerColumn(owner: InternalOwner): 'user_id' | 'project_id' {
  if (owner.userId !== undefined) return 'user_id'
  if (owner.projectId !== undefined) return 'project_id'
  throw new PluginStateError(404, 'plugin state owner not found')
}

function ownerId(owner: InternalOwner): string {
  return owner.userId ?? owner.projectId ?? ''
}

/** Read one saved state's managed rows; unexpected keys or non-literal values were hand-authored. */
function parseEntries(value: unknown): PluginStateEntry[] {
  if (!Array.isArray(value)) throw new PluginStateError(500, 'plugin state rows must be an array')
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new PluginStateError(500, 'plugin state row must be an object')
    }
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id === '' || typeof row.disabled !== 'boolean'
      || Object.keys(row).some(key => key !== 'id' && key !== 'name' && key !== 'disabled')
      || ('name' in row && typeof row.name !== 'string')) {
      throw new PluginStateError(500, 'plugin state row must carry id, optional name, and a boolean disabled only')
    }
    return 'name' in row
      ? { id: row.id, name: row.name as string, disabled: row.disabled }
      : { id: row.id, disabled: row.disabled }
  })
}

function parseBundles(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    throw new PluginStateError(500, 'plugin state bundles must be an array of names')
  }
  return value as string[]
}

function parseState(row: { entries: unknown; bundles: unknown }): PluginDesiredState {
  return { entries: parseEntries(row.entries), bundles: parseBundles(row.bundles) }
}

/** Validate an administrator- or runtime-submitted state before it reaches the store. */
export function parseDesiredState(value: unknown): PluginDesiredState {
  try {
    return parseState(value as { entries: unknown; bundles: unknown })
  } catch (error) {
    if (error instanceof PluginStateError) throw new PluginStateError(400, error.message)
    throw error
  }
}

/**
 * Manager-owned patch rows are non-insert maps whose keys stay within
 * `{id, name, disabled}` and whose values stay literal. Rows carrying a
 * `!!js` expression or additional keys are hand-authored and preserved.
 */
function managedRow(document: ReturnType<typeof parseDocument>, index: number): boolean {
  if (!isSeq(document.contents)) return false
  const item = document.contents.items[index]
  if (item === undefined || !isMap(item) || item.has('insert')) return false
  if (item.items.some(pair => !['id', 'name', 'disabled'].includes(String(pair.key)))) return false
  const id = document.getIn([index, 'id'])
  const name = document.getIn([index, 'name'])
  return typeof id === 'string' && typeof document.getIn([index, 'disabled']) === 'boolean'
    && (name === undefined || typeof name === 'string')
}

/** Read the profile patch's managed rows verbatim, in file order; an unreadable patch yields none. */
async function readManagedRows(patchPath: string): Promise<PluginStateEntry[]> {
  let text: string
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length > 0 || !isSeq(document.contents)) return []
  const entries: PluginStateEntry[] = []
  for (let index = 0; index < document.contents.items.length; index += 1) {
    if (!managedRow(document, index)) continue
    const name = document.getIn([index, 'name'])
    entries.push({ id: document.getIn([index, 'id']) as string, disabled: document.getIn([index, 'disabled']) as boolean,
      ...(name === undefined ? {} : { name: String(name) }) })
  }
  return entries
}

/** Read `dsh.profile.bundles` out of the profile manifest, tolerating absence and damage. */
async function readManifestBundles(manifestPath: string): Promise<string[] | undefined> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const bundles = (manifest as { dsh?: { profile?: { bundles?: unknown } } })?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : []
}

/** The desired state the profile files currently express; null before the first launch materializes them. */
export async function readObservedState(profileDir: string): Promise<PluginDesiredState | null> {
  const bundles = await readManifestBundles(join(profileDir, 'package.json'))
  if (bundles === undefined) return null
  return { entries: await readManagedRows(join(profileDir, 'cordis.patch.yml')), bundles }
}

/**
 * Replace the profile's managed rows and bundle selection with the desired
 * state, preserving hand-authored patch rows and every unrelated manifest
 * field. A missing profile receives a minimal manifest mirroring the
 * launcher template's shape.
 */
export async function projectDesiredState(profileDir: string, desired: PluginDesiredState): Promise<void> {
  await mkdir(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let text: string
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  for (let index = document.contents.items.length - 1; index >= 0; index -= 1) {
    if (managedRow(document, index)) document.deleteIn([index])
  }
  for (const entry of desired.entries) {
    const row: Record<string, unknown> = { id: entry.id }
    if (entry.name !== undefined) row.name = entry.name
    row.disabled = entry.disabled
    document.add(row)
  }
  await writeFileAtomic(patchPath, String(document), { mode: 0o600 })

  const manifestPath = join(profileDir, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    manifest = { name: `dsh-profile-${basename(profileDir)}`, private: true, dependencies: {} }
  }
  const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null ? manifest.dsh as Record<string, unknown> : {}
  const profile = typeof dsh.profile === 'object' && dsh.profile !== null ? dsh.profile as Record<string, unknown> : {}
  manifest.dsh = { ...dsh, profile: { ...profile, bundles: [...desired.bundles] } }
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 })
}

/** PostgreSQL-backed `harness.plugin_states` store keyed by the persistent Runtime identity. */
export class PostgresPluginState {
  constructor(private readonly context: PostgresRuntimeContext) {}

  private async resolveOwner(owner: RuntimeTarget, querier?: Querier, lock = false): Promise<InternalOwner> {
    const table = owner.kind === 'user' ? 'users' : 'projects', column = owner.kind === 'user' ? 'user_id' : 'project_id'
    const result = await (querier ?? this.context.pool).query<{ id: string; organization_id: string; runtime_id: RuntimeId }>(
      `SELECT owner.id,owner.organization_id,i.runtime_id FROM harness.${table} owner
        JOIN harness.instances i ON i.organization_id=owner.organization_id AND i.${column}=owner.id
        WHERE owner.organization_id=$1 AND owner.public_id=$2 AND i.assigned_node_id=$3
          AND ($4::uuid IS NULL OR i.runtime_id=$4)
          ${owner.kind === 'user' ? 'AND owner.deleted_at IS NULL' : ''} ORDER BY i.runtime_id LIMIT 2${lock ? ' FOR UPDATE OF owner,i' : ''}`,
      [this.context.organizationId, owner.id, this.context.nodeId, owner.runtimeId ?? null])
    const row = result.rows[0]
    if (row === undefined) throw new PluginStateError(404, 'plugin Runtime not found on this computer')
    if (result.rows.length !== 1) throw new PluginStateError(409, 'plugin configuration requires an exact Runtime identity')
    return owner.kind === 'user'
      ? { organizationId: row.organization_id, runtimeId: row.runtime_id, userId: row.id }
      : { organizationId: row.organization_id, runtimeId: row.runtime_id, projectId: row.id }
  }

  private async readRow(querier: Querier, owner: InternalOwner): Promise<PluginStateSnapshot> {
    const result = await querier.query<{ entries: unknown; bundles: unknown; revision: string }>(
      `SELECT entries,bundles,revision::text FROM harness.plugin_states WHERE organization_id=$1 AND runtime_id=$2`,
      [owner.organizationId, owner.runtimeId])
    const row = result.rows[0]
    if (row === undefined) return { revision: '0', state: null }
    return { revision: row.revision, state: parseState(row) }
  }

  /**
   * Every saved desired state in this organization joined with the owner's
   * live instance row, for the administrator's cross-space overview. Spaces
   * without a saved override are absent: their composition is file-driven.
   * @returns one row per owner carrying counts and the runtime's liveness.
   */
  async list(): Promise<PluginStateOverviewRow[]> {
    const result = await this.context.pool.query<{
      user_public: number | null; project_public: number | null; runtime_id: RuntimeId
      username: string | null; project_name: string | null
      entries: unknown; bundles: unknown; revision: string; updated_at: string
      desired_state: string | null; observed_state: string | null; generation: number | null
    }>(
      `SELECT s.runtime_id,u.public_id AS user_public, p.public_id AS project_public,
        u.username, p.name AS project_name,
        s.entries, s.bundles, s.revision::text, s.updated_at::text,
        i.desired_state, i.observed_state, i.generation
       FROM harness.plugin_states s
       LEFT JOIN harness.users u ON u.id=s.user_id AND u.deleted_at IS NULL
       LEFT JOIN harness.projects p ON p.id=s.project_id
       JOIN harness.instances i ON i.organization_id=s.organization_id AND i.runtime_id=s.runtime_id
       WHERE s.organization_id=$1 AND i.assigned_node_id=$2
       ORDER BY s.updated_at DESC`,
      [this.context.organizationId, this.context.nodeId])
    const rows: PluginStateOverviewRow[] = []
    for (const row of result.rows) {
      const state = parseState(row)
      const target = row.user_public !== null
        ? { kind: 'user' as const, id: row.user_public, runtimeId: row.runtime_id, label: row.username ?? `user ${row.user_public}` }
        : row.project_public !== null
          ? { kind: 'project' as const, id: row.project_public, runtimeId: row.runtime_id, label: row.project_name ?? `project ${row.project_public}` }
          : undefined
      if (target === undefined) continue
      rows.push({ target, entries: state.entries.length, disabled: state.entries.filter(entry => entry.disabled).length,
        bundles: state.bundles.length, revision: row.revision, updatedAt: row.updated_at,
        live: row.observed_state === 'ready', generation: row.generation })
    }
    return rows
  }

  /**
   * Read the desired state for an administrator, resolving the public owner id.
   * @param owner - account or project within this organization.
   * @returns the saved state and revision, or the revision-zero default.
   */
  async get(owner: RuntimeTarget): Promise<PluginStateSnapshot> {
    return this.readRow(this.context.pool, await this.resolveOwner(owner))
  }

  /**
   * Atomically replace or delete one desired state under its observed
   * revision. A null state deletes the row: absent state means no override.
   * @param owner - account or project within this organization.
   * @param state - the complete desired composition, or null to clear it.
   * @param revision - decimal revision the editor read; '0' requires an absent row.
   * @param actorUserId - current administrator retained through the configuration write.
   * @returns the committed revision and state.
   */
  async set(owner: RuntimeTarget, state: PluginDesiredState | null, revision: unknown, actorUserId?: number): Promise<PluginStateSnapshot> {
    if (typeof revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(revision)) {
      throw new PluginStateError(400, 'invalid plugin state revision')
    }
    return transaction(this.context.pool, async (client) => {
      if (actorUserId !== undefined) await lockAdministrator(client, this.context, actorUserId)
      const internal = await this.resolveOwner(owner, client, true)
      await this.assertCompositionMutable(client, internal)
      const current = await client.query<{ revision: string }>(
        `SELECT revision::text FROM harness.plugin_states WHERE organization_id=$1 AND runtime_id=$2 FOR UPDATE`,
        [internal.organizationId, internal.runtimeId])
      const currentRevision = current.rows[0]?.revision ?? '0'
      if (currentRevision !== revision) throw new PluginStateError(409, 'plugin state changed; reload before saving')
      if (state === null) {
        if (current.rows.length === 0) return { revision: '0', state: null }
        await client.query(`DELETE FROM harness.plugin_states WHERE organization_id=$1 AND runtime_id=$2`,
          [internal.organizationId, internal.runtimeId])
        return { revision: '0', state: null }
      }
      const entries = JSON.stringify(state.entries), bundles = JSON.stringify(state.bundles)
      const result = current.rows.length === 0
        ? await client.query<{ revision: string }>(
          `INSERT INTO harness.plugin_states(organization_id,runtime_id,entries,bundles,revision,${ownerColumn(internal)})
            VALUES($1,$2,$3::jsonb,$4::jsonb,1,$5) RETURNING revision::text`,
          [internal.organizationId, internal.runtimeId, entries, bundles, ownerId(internal)])
        : await client.query<{ revision: string }>(
          `UPDATE harness.plugin_states SET entries=$3::jsonb,bundles=$4::jsonb,revision=revision+1,updated_at=now()
            WHERE organization_id=$1 AND runtime_id=$2 RETURNING revision::text`,
          [internal.organizationId, internal.runtimeId, entries, bundles])
      return { revision: result.rows[0]!.revision, state }
    })
  }

  private async subjectOwner(
    subject: { organizationId: string; target?: RuntimeTarget; generation?: number; userInternalId?: string; projectInternalId?: string },
    querier: Querier = this.context.pool,
    lock = false,
  ): Promise<InternalOwner> {
    const column = subject.userInternalId === undefined ? 'project_id' : 'user_id'
    const id = subject.userInternalId ?? subject.projectInternalId
    if (id === undefined) throw new PluginStateError(404, 'plugin Runtime owner not found')
    const result = await querier.query<{ runtime_id: RuntimeId }>(`SELECT runtime_id FROM harness.instances
      WHERE organization_id=$1 AND assigned_node_id=$2 AND ${column}=$3
        AND ($4::uuid IS NULL OR runtime_id=$4) AND ($5::bigint IS NULL OR generation=$5)
      ORDER BY runtime_id LIMIT 2${lock ? ' FOR UPDATE' : ''}`,
    [subject.organizationId, this.context.nodeId, id, subject.target?.runtimeId ?? null, subject.generation ?? null])
    if (result.rows.length !== 1) throw new PluginStateError(409, 'plugin publication requires its current Runtime assignment')
    return { organizationId: subject.organizationId, runtimeId: result.rows[0]!.runtime_id,
      ...(column === 'user_id' ? { userId: id } : { projectId: id }) }
  }

  /**
   * The steward runtime's composition is fixed at launch: a self-published or
   * administrator-saved change could restart the resident maintainer out from
   * under its own session, so project-scoped writes to the steward row fail.
   */
  private async assertCompositionMutable(querier: Querier, owner: InternalOwner): Promise<void> {
    if (owner.projectId === undefined) return
    const result = await querier.query(
      `SELECT 1 FROM harness.projects WHERE organization_id=$1 AND id=$2 AND kind='steward'`,
      [owner.organizationId, owner.projectId])
    if (result.rows.length > 0) throw new PluginStateError(403, 'steward runtime composition is fixed')
  }

  /**
   * Read the desired state for the runtime the credential authenticates,
   * joined with the instance's applied marker: the revision this runtime's
   * profile files were materialized from. A publisher that booted before an
   * administrator's newer save bases its write on the marker, not the head,
   * so the save still conflicts instead of being silently overwritten.
   * @param subject - authenticated runtime identity carrying its internal owner id.
   * @returns the saved snapshot plus the applied marker; both '0' when the instance never launched here.
   */
  async readForSubject(subject: { organizationId: string; target?: RuntimeTarget; userInternalId?: string; projectInternalId?: string }): Promise<PluginStateSnapshot & { appliedRevision: string }> {
    const internal = await this.subjectOwner(subject)
    const result = await this.context.pool.query<{ entries: unknown; bundles: unknown; revision: string; applied: string }>(
      `SELECT s.entries,s.bundles,COALESCE(s.revision,0)::text revision,
        COALESCE(i.applied_policy_revision,0)::text applied
        FROM harness.instances i
        LEFT JOIN harness.plugin_states s ON s.organization_id=i.organization_id
          AND s.runtime_id=i.runtime_id
        WHERE i.organization_id=$1 AND i.runtime_id=$2 AND i.assigned_node_id=$3`,
      [internal.organizationId, internal.runtimeId, this.context.nodeId])
    const row = result.rows[0]
    if (row === undefined) return { revision: '0', state: null, appliedRevision: '0' }
    return {
      revision: row.revision,
      state: row.entries === null || row.bundles === null ? null : parseState(row),
      appliedRevision: row.applied,
    }
  }

  /**
   * Publish the live profile's observed composition under the revision the
   * caller last saw, then mark the running generation as having applied it.
   * @param subject - authenticated runtime identity carrying target and generation.
   * @param state - the profile files' complete managed composition.
   * @param baseRevision - revision the runtime based this write on.
   * @returns the committed revision, or a conflict carrying the current row.
   */
  async publishForSubject(
    subject: { organizationId: string; target: RuntimeTarget; generation: number; userInternalId?: string; projectInternalId?: string },
    state: unknown,
    baseRevision: unknown,
  ): Promise<{ status: 'applied'; revision: string } | { status: 'conflict'; current: PluginStateSnapshot }> {
    const desired = parseDesiredState(state)
    if (typeof baseRevision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(baseRevision)) {
      throw new PluginStateError(400, 'invalid plugin state base revision')
    }
    return transaction(this.context.pool, async (client) => {
      const internal = await this.subjectOwner(subject, client, true)
      await this.assertCompositionMutable(client, internal)
      const current = await client.query<{ entries: unknown; bundles: unknown; revision: string }>(
        `SELECT entries,bundles,revision::text FROM harness.plugin_states WHERE organization_id=$1 AND runtime_id=$2 FOR UPDATE`,
        [internal.organizationId, internal.runtimeId])
      const row = current.rows[0]
      if ((row?.revision ?? '0') !== baseRevision) {
        return {
          status: 'conflict' as const,
          current: row === undefined ? { revision: '0', state: null } : { revision: row.revision, state: parseState(row) },
        }
      }
      const entries = JSON.stringify(desired.entries), bundles = JSON.stringify(desired.bundles)
      const result = row === undefined
        ? await client.query<{ revision: string }>(
          `INSERT INTO harness.plugin_states(organization_id,runtime_id,entries,bundles,revision,${ownerColumn(internal)})
            VALUES($1,$2,$3::jsonb,$4::jsonb,1,$5) RETURNING revision::text`,
          [internal.organizationId, internal.runtimeId, entries, bundles, ownerId(internal)])
        : await client.query<{ revision: string }>(
          `UPDATE harness.plugin_states SET entries=$3::jsonb,bundles=$4::jsonb,revision=revision+1,updated_at=now()
            WHERE organization_id=$1 AND runtime_id=$2 RETURNING revision::text`,
          [internal.organizationId, internal.runtimeId, entries, bundles])
      const revision = result.rows[0]!.revision
      // The publisher's files are exactly what this revision stores: mark the
      // running generation so its next start skips re-projecting what it wrote.
      await client.query(
        `UPDATE harness.instances SET applied_policy_revision=$3,updated_at=now()
          WHERE organization_id=$1 AND runtime_id=$2 AND generation=$4 AND assigned_node_id=$5`,
        [internal.organizationId, internal.runtimeId, revision, subject.generation, this.context.nodeId])
      return { status: 'applied' as const, revision }
    })
  }

  /**
   * Decide whether this launch must re-materialize the profile files: a saved
   * revision newer than what the instance last applied. Read-only; the caller
   * invokes {@link markApplied} after the files land.
   * @param target - launching runtime owner.
   * @returns the state to project, null when absent, or 'current' when files already hold it.
   */
  async projection(target: RuntimeTarget): Promise<{ revision: string; state: PluginDesiredState } | 'current' | null> {
    const internal = await this.resolveOwner(target)
    const result = await this.context.pool.query<{ entries: unknown; bundles: unknown; revision: string; applied: string }>(
      `SELECT s.entries,s.bundles,s.revision::text,COALESCE(i.applied_policy_revision,0)::text applied
        FROM harness.plugin_states s
        LEFT JOIN harness.instances i ON i.organization_id=s.organization_id
          AND i.runtime_id=s.runtime_id AND i.assigned_node_id=$3
        WHERE s.organization_id=$1 AND s.runtime_id=$2`,
      [internal.organizationId, internal.runtimeId, this.context.nodeId])
    const row = result.rows[0]
    if (row === undefined) return null
    if (BigInt(row.applied) >= BigInt(row.revision)) return 'current'
    return { revision: row.revision, state: parseState(row) }
  }

  /**
   * Read the desired-state revision this node's instance row last materialized.
   * @param target - runtime owner.
   * @returns the applied marker; '0' when the instance never launched here.
   */
  async applied(target: RuntimeTarget): Promise<string> {
    const internal = await this.resolveOwner(target)
    const result = await this.context.pool.query<{ applied: string }>(
      `SELECT COALESCE(applied_policy_revision,0)::text applied FROM harness.instances
        WHERE organization_id=$1 AND runtime_id=$2 AND assigned_node_id=$3`,
      [internal.organizationId, internal.runtimeId, this.context.nodeId])
    return result.rows[0]?.applied ?? '0'
  }

  /**
   * Record the desired-state revision a launch materialized, so later starts
   * skip re-projecting and the runtime's write-back detects administrator
   * writes that landed after it.
   * @param target - launched runtime owner.
   * @param revision - the projected revision.
   */
  async markApplied(target: RuntimeTarget, revision: string): Promise<void> {
    const internal = await this.resolveOwner(target)
    await this.context.pool.query(
      `UPDATE harness.instances SET applied_policy_revision=$3,updated_at=now()
        WHERE organization_id=$1 AND runtime_id=$2 AND assigned_node_id=$4`,
      [internal.organizationId, internal.runtimeId, revision, this.context.nodeId])
  }

  /**
   * Read the on-disk composition for an offline editor: the profile's current
   * managed rows and selected bundles.
   * @param dshHome - the owner's runtime home.
   * @returns the observed composition, or null before the first launch.
   */
  async observed(dshHome: string): Promise<PluginDesiredState | null> {
    return readObservedState(join(dshHome, 'profiles', INSTANCE_PROFILE))
  }

  /**
   * Materialize a newer saved revision into the launching profile's files.
   * @param dshHome - the launching runtime's home.
   * @param state - the desired composition to write.
   */
  async project(dshHome: string, state: PluginDesiredState): Promise<void> {
    await projectDesiredState(join(dshHome, 'profiles', INSTANCE_PROFILE), state)
  }
}
