/** Passive, paged account directory for an explicitly scoped multi-computer entry. */
import type { OwnerProjectDisplay } from './project-metadata.ts'
import { addressRuntimeUrl, runtimeTargetKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionRuntimeTarget } from './contract/sessions.ts'

type Read = (url: string, signal?: AbortSignal) => Promise<unknown>
type Json = Record<string, unknown>
type ReadOptions = { kind: 'workspaces' | 'conversations'; cursor?: string; q?: string; workspaceId?: string; includeConversations?: boolean }

/** Picker and sidebar request only the target/page explicitly visible in this document. */
export interface DirectoryPageSelection {
  readonly scope?: string
  readonly q?: string
  readonly cursor?: string
}

function record(input: unknown): Json {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid computer directory')
  return input as Json
}
function cursor(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) throw new Error('Invalid directory cursor')
  return value
}
function uuid(value: unknown): value is NonNullable<SessionRuntimeTarget['runtimeId']> {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)
}

interface Environment { target: SessionRuntimeTarget; status: string; observedState: string; metadataOnNode?: true }

function environments(input: unknown, account: number): { entries: Environment[]; nextCursor: string | null } {
  const page = record(input)
  if (!Array.isArray(page.items)) throw new Error('Invalid Runtime directory')
  const entries: Environment[] = []
  for (const entry of page.items) {
    const row = record(entry), owner = record(row.owner), node = record(row.node)
    if (!uuid(row.id) || !uuid(node.id) || typeof node.name !== 'string' || typeof row.observedState !== 'string'
      || typeof node.status !== 'string' || typeof owner.name !== 'string' || typeof owner.id !== 'number' || !Number.isSafeInteger(owner.id)
      || (owner.kind !== 'personal' && owner.kind !== 'project')) throw new Error('Invalid authorized Runtime')
    if (owner.kind === 'personal' && owner.id !== account) continue
    const location = { runtimeId: row.id, nodeId: String(node.id) as NonNullable<SessionRuntimeTarget['nodeId']>, nodeName: node.name }
    const target: SessionRuntimeTarget = owner.kind === 'personal' ? { kind: 'personal', ...location }
      : { kind: 'project', projectId: owner.id, projectName: row.metadataOnNode === true ? `#${owner.id}` : owner.name, ...location }
    entries.push({ target, status: node.status, observedState: row.observedState,
      ...(row.metadataOnNode === true ? { metadataOnNode: true } : {}) })
  }
  return { entries, nextCursor: cursor(page.nextCursor) }
}

interface Rows { items: Json[]; workspaces: Json[]; nextCursor: string | null; combined?: true }
interface Loaded {
  items: Map<string, Json>
  workspaces: Map<string, Json>
  conversationsCursor?: string | null
  workspacesCursor?: string | null
  syncedAt?: string
}

/** Directory owned by one verified entry. No request to the execution API is made here. */
export class EntryDirectory {
  private epoch = 0
  private readonly revoked = new Set<() => void>()
  /** React subscribers discard the previous account's displayed rows as soon as grants are cleared. */
  readonly authority = {
    getSnapshot: () => this.epoch,
    subscribe: (notify: () => void) => { this.revoked.add(notify); return () => { this.revoked.delete(notify) } },
  }
  private entries = new Map<string, Environment>()
  private retained = new Map<string, Loaded>()
  private members: Json[] = []
  private personal: { id: number; name: string } | undefined
  private active: SessionRuntimeTarget | undefined
  private more: string | null = null

  /** @param read - account-fenced, bounded and coalesced metadata reader. */
  constructor(private readonly read: Read) {}

  /** Whether this account's deployment metadata has been read in the current generation. */
  get ready(): boolean { return this.active !== undefined }

  /** Discover central grants and project memberships without a node-content fan-out.
   * @param account - current verified account.
   * @param bootstrap - this tab's authenticated Runtime target.
   * @param signal - caller lifetime.
   * @param next - explicitly load the next governance page.
   * @returns metadata for authorized targets retained in this document.
   */
  async manifest(account: number, bootstrap: SessionRuntimeTarget, signal?: AbortSignal, next = false): Promise<void> {
    const version = this.epoch
    if (bootstrap.runtimeId === undefined) throw new Error('Computer directory requires a verified active Runtime')
    const pageCursor = next ? this.more : null
    if (next && pageCursor === null) return
    const governance = '/account/api/runtimes' + (pageCursor === null ? '' : `?cursor=${encodeURIComponent(pageCursor)}`)
    const contextUrl = new URL('/account/api/context', globalThis.location.origin)
    addressRuntimeUrl(contextUrl, bootstrap)
    const [raw, context] = await Promise.all([this.read(governance, signal), this.read(contextUrl.pathname + contextUrl.search, signal)])
    signal?.throwIfAborted()
    if (this.epoch !== version) throw new Error('Computer directory owner changed')
    const root = record(context), user = record(root.user), env = record(root.environment)
    if (user.id !== account || typeof user.displayName !== 'string' || env.id !== bootstrap.runtimeId || !Array.isArray(root.projects)) {
      throw new Error('Computer directory returned a different account or environment')
    }
    const page = environments(raw, account)
    const granted = next ? new Map(this.entries) : new Map<string, Environment>()
    for (const item of page.entries) granted.set(runtimeTargetKey(item.target), item)
    if (!granted.has(runtimeTargetKey(bootstrap))) {
      const own = environments(await this.read(`/account/api/runtimes?ids=${encodeURIComponent(bootstrap.runtimeId)}`, signal), account)
      signal?.throwIfAborted()
      if (this.epoch !== version) throw new Error('Computer directory owner changed')
      const match = own.entries.find(row => runtimeTargetKey(row.target) === runtimeTargetKey(bootstrap))
      if (match === undefined) throw new Error('Active Runtime is not available in this entry')
      granted.set(runtimeTargetKey(match.target), match)
    }
    this.entries = granted
    for (const key of this.retained.keys()) if (!granted.has(key)) this.retained.delete(key)
    this.members = root.projects.map(record).map(member => member.metadataOnNode === true
      ? { ...member, name: `#${String(member.projectId)}`, path: '' } : member)
    this.personal = { id: account, name: user.displayName }
    this.active = granted.get(runtimeTargetKey(bootstrap))?.target
    this.more = page.nextCursor
  }

  /** Resolve an authorized picker selection.
   * @param scope - picker value; an empty value selects only the current Runtime.
   * @returns the explicitly selected and currently granted target, when unambiguous.
   */
  target(scope: string): SessionRuntimeTarget | undefined {
    if (scope === '') return this.active && this.entries.get(runtimeTargetKey(this.active))?.target
    const personal = [...this.entries.values()].map(row => row.target).filter(item => item.kind === 'personal')
    if (scope === 'personal') return personal.length === 1 && this.more === null ? personal[0] : undefined
    if (scope.startsWith('personal:')) return personal.find(item => item.runtimeId === scope.slice('personal:'.length))
    return [...this.entries.values()].map(row => row.target).find(item => item.kind === 'project' && String(item.projectId) === scope)
  }

  /** Resolve the exact allocation of a selected member project outside the loaded governance pages.
   * @param scope - selected picker value.
   * @param account - authenticated browser principal.
   * @param signal - picker lifetime.
   * @returns a previously or newly authorized allocation, when available.
   */
  async selection(scope: string, account: number, signal?: AbortSignal): Promise<SessionRuntimeTarget | undefined> {
    const known = this.target(scope)
    const member = this.members.find(row => typeof row.projectId === 'number' && String(row.projectId) === scope)
    if (known || !member || this.more === null) return known
    const version = this.epoch
    const raw = record(await this.read(`/account/api/runtimes?projectId=${encodeURIComponent(scope)}`, signal))
    const page = environments(raw, account)
    signal?.throwIfAborted()
    if (this.epoch !== version) throw new Error('Project directory changed')
    const count = (raw.items as unknown[]).length
    if (count === 0 && page.nextCursor === null) return undefined
    const [entry] = page.entries
    if (page.nextCursor !== null || count !== 1 || entry?.target.kind !== 'project' || entry.target.projectId !== member.projectId
      || member.nodeId !== undefined && entry.target.nodeId !== member.nodeId
      || member.runtimeId !== undefined && entry.target.runtimeId !== member.runtimeId) {
      throw new Error('Project directory returned a different allocation')
    }
    this.entries.set(runtimeTargetKey(entry.target), entry)
    return entry.target
  }

  /** Resolve the metadata owner for an explicitly selected placed project.
   * @param target - authorized selected allocation.
   * @returns the owned project reference when its display still needs resolution.
   */
  projectRef(target: SessionRuntimeTarget): Pick<OwnerProjectDisplay, 'projectId' | 'nodeId' | 'runtimeId'> & { version: number } | undefined {
    if (target.kind !== 'project' || !target.runtimeId || !target.nodeId) return undefined
    const member = this.members.find(item => item.projectId === target.projectId)
    if (!member || member.ownerDisplayLoaded) return undefined
    if (member.metadataOnNode !== true && !this.entries.get(runtimeTargetKey(target))?.metadataOnNode) return undefined
    return { projectId: target.projectId, nodeId: target.nodeId, runtimeId: target.runtimeId, version: this.epoch }
  }

  /** Apply display data only while the project still belongs to this verified directory.
   * @param display - freshly authorized owner response.
   * @param version - directory generation that authorized the read.
   */
  receiveProject(display: OwnerProjectDisplay, version: number): void {
    if (this.epoch !== version) throw new Error('Project directory changed')
    const target = this.target(String(display.projectId))
    if (target?.runtimeId !== display.runtimeId || target.nodeId !== display.nodeId) throw new Error('Project owner changed')
    this.members = this.members.map(row => row.projectId === display.projectId
      ? { ...row, name: display.name, path: display.rootPath, ownerDisplayLoaded: true } : row)
  }

  /** Read one selected node's rows without waking its Host.
   * @param target - authorized allocation.
   * @param options - row type, optional Workspace, literal search and opaque cursor.
   * @param signal - consumer cancellation.
   * @returns the verified page and its continuation token.
   */
  async rows(target: SessionRuntimeTarget, options: ReadOptions, signal?: AbortSignal): Promise<Rows> {
    const key = runtimeTargetKey(target), version = this.epoch
    if (target.runtimeId === undefined || !this.entries.has(key)) throw new Error('Computer is unavailable')
    const url = new URL('/account/api/workbench/rows', globalThis.location.origin)
    addressRuntimeUrl(url, target)
    url.searchParams.set('kind', options.kind)
    for (const field of ['q', 'cursor', 'workspaceId'] as const) if (options[field]) url.searchParams.set(field, options[field])
    if (options.includeConversations) url.searchParams.set('include', 'conversations')
    let value: unknown
    try {
      value = await this.read(url.pathname + url.search, signal)
    } catch (error) {
      if (this.epoch === version && !signal?.aborted && error instanceof Error && 'status' in error) {
        if (error.status === 401) this.clear()
        else if (error.status === 403) this.withdraw(target)
      }
      throw error
    }
    signal?.throwIfAborted()
    if (this.epoch !== version || !this.entries.has(key)) throw new Error('Computer directory changed')
    if (value === undefined) {
      this.withdraw(target)
      throw new Error('Computer directory is unavailable')
    }
    const raw = record(value)
    const page = this.parseRows(target, raw)
    const conversations = options.includeConversations && raw.conversationPage !== undefined
      ? this.parseRows(target, record(raw.conversationPage)) : undefined
    this.rememberRows(key, options, page)
    if (conversations !== undefined) {
      this.rememberRows(key, { kind: 'conversations' }, conversations)
      return { ...page, combined: true }
    }
    return page
  }

  private parseRows(target: SessionRuntimeTarget, page: Json): Rows {
    if (page.runtimeId !== target.runtimeId || !Array.isArray(page.items) || !Array.isArray(page.workspaces)) {
      throw new Error('Directory page does not match the selected Runtime')
    }
    const items = page.items.map(record), workspaces = page.workspaces.map(record)
    for (const row of items) {
      const owner = record(row.runtime)
      if (typeof row.sessionId !== 'string' || owner.kind !== target.kind || owner.runtimeId !== target.runtimeId
        || target.nodeId !== undefined && owner.nodeId !== undefined && owner.nodeId !== target.nodeId
        || target.kind === 'project' && owner.projectId !== target.projectId) throw new Error('Conversation page returned another owner')
    }
    for (const row of workspaces) if (typeof row.workspaceId !== 'string' || !Array.isArray(row.sessionIds)
      || !row.sessionIds.every(id => typeof id === 'string')) throw new Error('Invalid Workspace page')
    return { items, workspaces, nextCursor: cursor(page.nextCursor) }
  }

  private rememberRows(key: string, options: ReadOptions, { items, workspaces, nextCursor }: Rows): void {
    const partial = Boolean(options.q || options.workspaceId)
    if (partial && options.kind !== 'conversations') return
    const prior: Loaded = this.retained.get(key) ?? { items: new Map(), workspaces: new Map() }
    if (!partial && !options.cursor) {
      if (options.kind === 'conversations') prior.items.clear()
      else prior.workspaces.clear()
    }
    for (const item of items) prior.items.set(String(item.sessionId), item)
    for (const row of workspaces) {
      const known = prior.workspaces.get(String(row.workspaceId))?.sessionIds
      const previous: unknown[] = Array.isArray(known) ? known : []
      const membership = row.sessionIds as unknown[]
      prior.workspaces.set(String(row.workspaceId), { ...row, sessionIds: [...new Set([...previous, ...membership])] })
    }
    if (!partial) {
      if (options.kind === 'workspaces') prior.workspacesCursor = nextCursor
      else prior.conversationsCursor = nextCursor
      prior.syncedAt = new Date().toISOString()
    }
    this.retained.set(key, prior)
  }

  /** Project the loaded history across granted spaces, or a page for one explicitly selected owner.
   * @param visible - selected scope and optional owner-verified search results.
   * @returns metadata compatible with the personal sidebar and workbench picker.
   */
  snapshot(visible?: { scope: string; page?: Rows; q?: string }): unknown {
    if (this.active === undefined || this.personal === undefined) throw new Error('Computer directory is unavailable')
    const scope = visible?.scope
    const selected = scope ? this.target(scope) : undefined
    const granted = [...this.entries].filter(([key, entry]) => scope === undefined || scope === ''
      || (selected === undefined ? scope === 'personal' && entry.target.kind === 'personal' : key === runtimeTargetKey(selected)))
    const includesUnread = this.more !== null || granted.some(([key]) => this.retained.get(key)?.conversationsCursor !== null)
    const partial = scope === undefined ? undefined : selected === undefined && (includesUnread || scope !== '' && scope !== 'personal')
    const q = visible?.q?.toLocaleLowerCase()
    const nextCursor = visible?.page?.nextCursor ?? (scope === '' && !q
      ? this.retained.get(runtimeTargetKey(this.active))?.conversationsCursor : null)
    const items = visible?.page && selected ? visible.page.items : granted.flatMap(([key, { target }]) => {
      const rows = [...this.retained.get(key)?.items.values() ?? []]
      if (!q) return rows
      const name = target.kind === 'project' ? this.members.find(member => member.projectId === target.projectId)?.name : this.personal?.name
      return rows.filter(row => [row.title, row.sessionId, row.cwd, target.nodeName, name]
        .some(field => typeof field === 'string' && field.toLocaleLowerCase().includes(q)))
    })
    return { activeRuntime: this.active, personal: this.personal, personalComplete: false, paged: true, computerCursor: this.more,
      ...(partial === undefined ? {} : { scopePartial: partial }),
      projects: this.members.map((member) => {
        const target = this.target(String(member.projectId))
        return target?.kind === 'project' ? { ...member, runtimeId: target.runtimeId, nodeId: target.nodeId, nodeName: target.nodeName } : member
      }), nextCursor: nextCursor ?? null,
      items,
      personalWorkspaces: [...this.entries].flatMap(([key, row]) => {
        if (row.target.kind !== 'personal') return []
        const loaded = this.retained.get(key)
        return [{ runtime: row.target, status: row.status, observedState: row.observedState, syncedAt: loaded?.syncedAt ?? null,
          items: [...loaded?.workspaces.values() ?? []], conversationsCursor: loaded?.conversationsCursor ?? null,
          workspacesCursor: loaded?.workspacesCursor ?? null }]
      }) }
  }

  /** Revoke cached grants, private rows and any reads from this generation. */
  clear(): void {
    this.epoch++
    this.entries.clear()
    this.retained.clear()
    this.members = []
    this.active = undefined
    this.personal = undefined
    this.more = null
    for (const notify of this.revoked) notify()
  }

  private withdraw(target: SessionRuntimeTarget): void {
    const key = runtimeTargetKey(target)
    this.entries.delete(key)
    this.retained.delete(key)
    if (target.kind === 'project') this.members = this.members.filter(row => row.projectId !== target.projectId)
    this.epoch++
    for (const notify of this.revoked) notify()
  }
}
