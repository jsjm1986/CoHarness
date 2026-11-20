/** Durable observed plugin inventory: each Runtime reports its loaded composition and administrators read one row per space. */
import { NodeContentUnavailable, type NodeContentBinding, type NodeContentStore } from './node-content-store.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import type { RuntimeTarget } from './instances.ts'
import {
  PluginStateError, parseDesiredState, resolvePluginRuntimeOwner, type PluginDesiredState,
} from './plugin-state.ts'

/** Localized display text a package exports: a literal or translations keyed by language id with an English fallback. */
export type InventoryLocalizedText = string | { en: string; [locale: string]: string }

/** Localizable display metadata reported for one bundle or runtime entry. */
export interface InventoryPluginMeta {
  title?: InventoryLocalizedText
  description?: InventoryLocalizedText
  /** Base64 image data URL; render as an image, not inline markup. */
  icon?: string
  error?: string
}

/** One composition row a reported bundle declares. */
export interface InventoryBundleRow {
  rowId: string
  moduleName: string
  meta?: InventoryPluginMeta
  entryId?: string
}

/** One bundle as the reporting Runtime's catalog lists it. */
export interface InventoryBundle {
  name: string
  version?: string
  meta?: InventoryPluginMeta
  description?: string
  enabled: boolean
  installed: boolean
  optional: boolean
  removable: boolean
  readOnlyReason?: string
  /** The install spec for a profile-owned package; local paths, git URLs, and registry ranges identify custom plugins. */
  source?: string
  error?: { code: string; diagnostic?: string }
  rows: InventoryBundleRow[]
  overrides: string[]
}

/** One live runtime entry as the reporting Runtime's catalog lists it. */
export interface InventoryPlugin {
  entryId: string
  moduleName: string
  meta?: InventoryPluginMeta
  enabled: boolean
  /** Root-fiber phase (`pending`, `loading`, `active`, `failed`, `unloading`) or null without a live fiber. */
  fiberPhase: string | null
  patchId?: string
  readOnlyReason?: string
}

/** The composition one Runtime last observed, as stored in `harness.plugin_inventory` or `node_content.plugin_inventory`. */
export interface PluginInventoryReport {
  bundles: InventoryBundle[]
  plugins: InventoryPlugin[]
}

/** One space's inventory row as the administrator's cross-space list returns it. */
export interface PluginInventorySpaceRow {
  target: RuntimeTarget & { label: string; steward: boolean }
  live: boolean
  generation: number | null
  /** Last report time; null while the runtime has never reported. */
  reportedAt: string | null
  /** The runtime's last reported catalog; null without a report. */
  inventory: PluginInventoryReport | null
  /** The saved desired composition, when a `plugin_states` override exists. */
  desired: PluginDesiredState | null
}

const MAX_INVENTORY_STRING = 8192
const MAX_INVENTORY_ICON = 262_144
const MAX_INVENTORY_BUNDLES = 1024
const MAX_INVENTORY_PLUGINS = 8192
const MAX_INVENTORY_ROWS = 1024

function fail(message: string): never {
  throw new PluginStateError(400, `plugin inventory report: ${message}`)
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

/** A non-empty bounded string for identity fields like names and entry ids. */
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_INVENTORY_STRING) fail(`${label} must be a non-empty string`)
  return value as string
}

/** A bounded string for annotation fields that may legitimately be empty. */
function boundedString(value: unknown, label: string, max = MAX_INVENTORY_STRING): string {
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be a string`)
  return value
}

function optionalBounded(value: unknown, label: string, max = MAX_INVENTORY_STRING): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, max)
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`)
  return value
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array of at most ${max} items`)
  return value
}

function localizedText(value: unknown, label: string): InventoryLocalizedText {
  if (typeof value === 'string') return boundedString(value, label)
  const object = asRecord(value, label)
  if (typeof object.en !== 'string' || object.en === '') fail(`${label} translations require an en fallback`)
  const out: Record<string, string> = { en: boundedString(object.en, `${label}.en`) }
  for (const [locale, text] of Object.entries(object)) {
    if (locale === 'en') continue
    out[locale] = boundedString(text, `${label}.${locale}`)
  }
  return out as InventoryLocalizedText
}

function meta(value: unknown, label: string): InventoryPluginMeta | undefined {
  if (value === undefined) return undefined
  const object = asRecord(value, label)
  const out: InventoryPluginMeta = {}
  if (object.title !== undefined) out.title = localizedText(object.title, `${label}.title`)
  if (object.description !== undefined) out.description = localizedText(object.description, `${label}.description`)
  if (object.icon !== undefined) out.icon = boundedString(object.icon, `${label}.icon`, MAX_INVENTORY_ICON)
  if (object.error !== undefined) out.error = boundedString(object.error, `${label}.error`)
  return out
}

function bundleRow(value: unknown, index: number): InventoryBundleRow {
  const object = asRecord(value, `bundle row ${index}`)
  const entryId = optionalBounded(object.entryId, `bundle row ${index} entryId`)
  return {
    rowId: requiredString(object.rowId, `bundle row ${index} rowId`),
    moduleName: requiredString(object.moduleName, `bundle row ${index} moduleName`),
    ...meta(object.meta, `bundle row ${index} meta`) === undefined ? {} : { meta: meta(object.meta, `bundle row ${index} meta`) },
    ...entryId === undefined ? {} : { entryId },
  }
}

function bundle(value: unknown, index: number): InventoryBundle {
  const object = asRecord(value, `bundle ${index}`)
  const error = object.error === undefined ? undefined : (() => {
    const record = asRecord(object.error, `bundle ${index} error`)
    const diagnostic = optionalBounded(record.diagnostic, `bundle ${index} error.diagnostic`)
    return { code: requiredString(record.code, `bundle ${index} error.code`), ...diagnostic === undefined ? {} : { diagnostic } }
  })()
  const version = optionalBounded(object.version, `bundle ${index} version`)
  const bundleMeta = meta(object.meta, `bundle ${index} meta`)
  const description = optionalBounded(object.description, `bundle ${index} description`)
  const readOnlyReason = optionalBounded(object.readOnlyReason, `bundle ${index} readOnlyReason`)
  const source = optionalBounded(object.source, `bundle ${index} source`)
  return {
    name: requiredString(object.name, `bundle ${index} name`),
    ...version === undefined ? {} : { version },
    ...bundleMeta === undefined ? {} : { meta: bundleMeta },
    ...description === undefined ? {} : { description },
    enabled: requiredBoolean(object.enabled, `bundle ${index} enabled`),
    installed: requiredBoolean(object.installed, `bundle ${index} installed`),
    optional: requiredBoolean(object.optional, `bundle ${index} optional`),
    removable: requiredBoolean(object.removable, `bundle ${index} removable`),
    ...readOnlyReason === undefined ? {} : { readOnlyReason },
    ...source === undefined ? {} : { source },
    ...error === undefined ? {} : { error },
    rows: array(object.rows ?? [], `bundle ${index} rows`, MAX_INVENTORY_ROWS).map(bundleRow),
    overrides: array(object.overrides ?? [], `bundle ${index} overrides`, MAX_INVENTORY_ROWS).map((item, itemIndex) => requiredString(item, `bundle ${index} override ${itemIndex}`)),
  }
}

function plugin(value: unknown, index: number): InventoryPlugin {
  const object = asRecord(value, `plugin ${index}`)
  const pluginMeta = meta(object.meta, `plugin ${index} meta`)
  const patchId = optionalBounded(object.patchId, `plugin ${index} patchId`)
  const readOnlyReason = optionalBounded(object.readOnlyReason, `plugin ${index} readOnlyReason`)
  return {
    entryId: requiredString(object.entryId, `plugin ${index} entryId`),
    moduleName: requiredString(object.moduleName, `plugin ${index} moduleName`),
    ...pluginMeta === undefined ? {} : { meta: pluginMeta },
    enabled: requiredBoolean(object.enabled, `plugin ${index} enabled`),
    fiberPhase: object.fiberPhase === undefined || object.fiberPhase === null
      ? null
      : boundedString(object.fiberPhase, `plugin ${index} fiberPhase`),
    ...patchId === undefined ? {} : { patchId },
    ...readOnlyReason === undefined ? {} : { readOnlyReason },
  }
}

/**
 * Validate and normalize one runtime-reported inventory before it reaches the
 * store. Unknown fields are dropped; malformed required fields reject the
 * whole report so partial compositions never masquerade as complete ones.
 * @param value - the `snapshot` the runtime posted.
 * @returns the report with only the documented fields.
 */
export function parseInventoryReport(value: unknown): PluginInventoryReport {
  const object = asRecord(value, 'report')
  return {
    bundles: array(object.bundles, 'bundles', MAX_INVENTORY_BUNDLES).map(bundle),
    plugins: array(object.plugins, 'plugins', MAX_INVENTORY_PLUGINS).map(plugin),
  }
}

/** Read one stored payload; a corrupt row degrades to absent rather than hiding the space. */
function storedReport(payload: unknown): PluginInventoryReport | null {
  if (payload === null || payload === undefined) return null
  try {
    return parseInventoryReport(payload)
  } catch (error) {
    if (error instanceof PluginStateError) return null
    throw error
  }
}

/** Read one stored desired-state row; a corrupt row degrades to absent. */
function storedDesired(entries: unknown, bundles: unknown): PluginDesiredState | null {
  if (entries === null || entries === undefined || bundles === null || bundles === undefined) return null
  try {
    return parseDesiredState({ entries, bundles })
  } catch (error) {
    if (error instanceof PluginStateError) return null
    throw error
  }
}

/** PostgreSQL-backed `plugin_inventory` store keyed by the persistent Runtime identity. */
export class PostgresPluginInventory {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly nodeContent?: Pick<NodeContentStore, 'read' | 'write' | 'readVolume'>,
  ) {}

  private nodeStore(binding: NodeContentBinding): Pick<NodeContentStore, 'read' | 'write' | 'readVolume'> {
    if (!this.nodeContent || binding.organizationId !== this.context.organizationId || binding.nodeId !== this.context.nodeId) {
      throw new NodeContentUnavailable()
    }
    return this.nodeContent
  }

  /**
   * Replace the reporting runtime's stored inventory. The write lands only
   * while the credential's generation still owns the instance row, so a stale
   * process cannot overwrite its successor's composition. Read-only reports
   * are accepted for every space, including steward compositions.
   * @param subject - authenticated runtime credential fields.
   * @param snapshot - the runtime's observed catalog; validated before storing.
   */
  async report(
    subject: { organizationId: string; target: RuntimeTarget; generation: number; userInternalId?: string; projectInternalId?: string },
    snapshot: unknown,
  ): Promise<void> {
    const inventory = parseInventoryReport(snapshot)
    const internal = await resolvePluginRuntimeOwner(this.context, subject, this.context.pool)
    if (internal.binding !== undefined) {
      await this.nodeStore(internal.binding).write(internal.binding, async (local) => {
        await local.query(
          `INSERT INTO node_content.plugin_inventory(organization_id,project_id,runtime_id,payload,generation) VALUES($1,$2,$3,$4::jsonb,$5)
           ON CONFLICT(organization_id,runtime_id) DO UPDATE SET payload=excluded.payload,generation=excluded.generation,updated_at=now()
           WHERE node_content.plugin_inventory.generation <= excluded.generation`,
          [internal.organizationId, internal.projectId!, internal.runtimeId, JSON.stringify(inventory), subject.generation])
      }, subject.generation)
      return
    }
    await this.context.pool.query(
      `INSERT INTO harness.plugin_inventory(organization_id,runtime_id,payload,generation) VALUES($1,$2,$3::jsonb,$4)
       ON CONFLICT(organization_id,runtime_id) DO UPDATE SET payload=excluded.payload,generation=excluded.generation,updated_at=now()
       WHERE harness.plugin_inventory.generation <= excluded.generation`,
      [internal.organizationId, internal.runtimeId, JSON.stringify(inventory), subject.generation])
  }

  /**
   * Every space with a live instance row on this node, joined with its last
   * inventory report and its saved desired composition. Spaces that never
   * reported return `inventory: null` with `desired` carrying the fallback.
   * @returns one row per instance, labeled by its account or project owner.
   */
  async list(): Promise<PluginInventorySpaceRow[]> {
    const result = await this.context.pool.query<{
      runtime_id: RuntimeId; user_public: string | null; project_public: string | null
      username: string | null; project_name: string | null; project_kind: string | null
      payload: unknown; reported_at: string | null
      state_entries: unknown; state_bundles: unknown
      desired_state: string | null; observed_state: string | null; generation: string
    }>(
      `SELECT i.runtime_id,u.public_id::text user_public,p.public_id::text project_public,
        u.username,p.name project_name,p.kind project_kind,
        inv.payload,inv.updated_at::text reported_at,
        s.entries state_entries,s.bundles state_bundles,
        i.desired_state,i.observed_state,i.generation::text generation
       FROM harness.instances i
       LEFT JOIN harness.users u ON u.organization_id=i.organization_id AND u.id=i.user_id AND u.deleted_at IS NULL
       LEFT JOIN harness.projects p ON p.organization_id=i.organization_id AND p.id=i.project_id
       LEFT JOIN harness.plugin_inventory inv ON inv.organization_id=i.organization_id AND inv.runtime_id=i.runtime_id
       LEFT JOIN harness.plugin_states s ON s.organization_id=i.organization_id AND s.runtime_id=i.runtime_id
       WHERE i.organization_id=$1 AND i.assigned_node_id=$2
         AND NOT EXISTS(SELECT FROM harness.project_content_placement b WHERE b.organization_id=i.organization_id AND b.runtime_id=i.runtime_id)
       ORDER BY u.username,p.name`,
      [this.context.organizationId, this.context.nodeId])
    const rows: PluginInventorySpaceRow[] = []
    for (const row of result.rows) {
      const target = row.user_public !== null
        ? { kind: 'user' as const, id: Number(row.user_public), runtimeId: row.runtime_id, label: row.username ?? `user ${row.user_public}`, steward: false }
        : row.project_public !== null
          ? { kind: 'project' as const, id: Number(row.project_public), runtimeId: row.runtime_id, label: row.project_name ?? `project ${row.project_public}`, steward: row.project_kind === 'steward' }
          : undefined
      if (target === undefined) continue
      rows.push({ target, live: row.observed_state === 'ready', generation: Number(row.generation),
        reportedAt: row.reported_at, inventory: storedReport(row.payload),
        desired: storedDesired(row.state_entries, row.state_bundles) })
    }
    const placed = await this.context.pool.query<{
      binding: NodeContentBinding & { nameVersion: string }; pid: string; kind: string
      desired_state: string; observed_state: string; generation: string
    }>(
      `SELECT harness.project_content_key(p.organization_id,p.id) binding,p.public_id::text pid,p.kind,
        i.desired_state,i.observed_state,i.generation::text
       FROM harness.project_content_placement b JOIN harness.projects p ON (p.organization_id,p.id)=(b.organization_id,b.project_id) AND p.status='active'
       JOIN harness.instances i ON (i.organization_id,i.runtime_id)=(b.organization_id,b.runtime_id)
       WHERE b.organization_id=$1 AND b.node_id=$2`,
      [this.context.organizationId, this.context.nodeId])
    if (placed.rows.length) {
      const store = this.nodeStore(placed.rows[0]!.binding)
      const snapshots = await store.readVolume(async local => (await local.query<{
        runtime_id: RuntimeId; payload: unknown; reported_at: string | null
        state_entries: unknown; state_bundles: unknown; name: string
      }>(
        `SELECT s.runtime_id,inv.payload,inv.updated_at::text reported_at,
          st.entries state_entries,st.bundles state_bundles,
          node_content.project_name_at(s.organization_id,s.project_id,s.runtime_id,k."nameVersion") name
         FROM jsonb_to_recordset($1::jsonb) k("organizationId" uuid,"projectId" uuid,"nodeId" uuid,"runtimeId" uuid,"volumeId" uuid,"writerEpoch" bigint,"nameVersion" uuid)
         JOIN node_content.spaces s ON (s.organization_id,s.project_id,s.node_id,s.runtime_id,s.volume_id,s.writer_epoch)=
           (k."organizationId",k."projectId",k."nodeId",k."runtimeId",k."volumeId",k."writerEpoch") AND s.publication_state<>'retired' AND NOT EXISTS(SELECT FROM node_content.recovery_candidates rc
            WHERE rc.organization_id=s.organization_id AND rc.runtime_id=s.runtime_id AND rc.phase<>'active')
         LEFT JOIN node_content.plugin_inventory inv ON (inv.organization_id,inv.runtime_id)=(s.organization_id,s.runtime_id)
         LEFT JOIN node_content.plugin_states st ON (st.organization_id,st.runtime_id)=(s.organization_id,s.runtime_id)`,
        [JSON.stringify(placed.rows.map(r => r.binding))])).rows)
      const targets = new Map(placed.rows.map(r => [r.binding.runtimeId, r]))
      for (const snapshot of snapshots) {
        const target = targets.get(snapshot.runtime_id)!
        rows.push({
          target: { kind: 'project', id: Number(target.pid), runtimeId: snapshot.runtime_id, label: snapshot.name, steward: target.kind === 'steward' },
          live: target.desired_state === 'running' && target.observed_state === 'ready', generation: Number(target.generation),
          reportedAt: snapshot.reported_at, inventory: storedReport(snapshot.payload),
          desired: storedDesired(snapshot.state_entries, snapshot.state_bundles),
        })
      }
    }
    return rows
  }
}
