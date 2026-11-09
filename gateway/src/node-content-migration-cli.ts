/** Admin-session CLI for the same explicit project preflight and migration operations as the deployment page. */
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateFileState } from './node-private-file.ts'
import { nodeMigrationPreflightSchema, nodeMigrationTargetSchema, type NodeMigrationPreflight } from './node-content-migration-protocol.ts'

interface Arguments { operation: 'preflight' | 'prepare' | 'publish'; origin: URL; node: string; project: number; reviewed?: string }
function parseArguments(args: readonly string[]): Arguments {
  const [operation, endpoint, node, id, reviewed] = args
  if (!endpoint || !node || !id || !/^\d+$/u.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1 ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(node) ||
    (operation !== 'preflight' && operation !== 'prepare' && operation !== 'publish') || args.length !== (operation === 'preflight' ? 4 : 5)) {
    throw new Error('Usage: preflight|prepare|publish <gateway-origin> <node-uuid> <project-number> [reviewed-preflight.json]')
  }
  const origin = new URL(endpoint)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
    origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) {
    throw new Error('Use the Gateway HTTPS origin or an explicit loopback origin without credentials, query or fragment.')
  }
  return {operation, origin, node, project:Number(id), ...(reviewed ? {reviewed} : {})}
}

async function sessionCookie(path: string | undefined): Promise<string> {
  if (!path || !isAbsolute(path)) throw new Error('Set HGW_ADMIN_SESSION_COOKIE_FILE to an absolute private Admin session file.')
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    if (await privateFileState(path, await file.stat(), 1024) !== 'private') throw new Error('The Admin session file must be private.')
    const cookie = (await file.readFile('utf8')).trim()
    if (!/^hgw_session=[A-Za-z0-9_-]{43}$/u.test(cookie)) throw new Error('The private file must contain exactly one hgw_session cookie.')
    return cookie
  } finally { await file.close() }
}

/** Never infer a mutation target or fetch a fresh snapshot to replace the operator's reviewed intent.
 * @param args - operation, HTTPS origin, node UUID, public project ID, and reviewed JSON for mutations.
 * @param environment - supplies the private original Admin session file.
 * @returns a verified, content-free project preflight suitable for the next explicit command.
 */
export async function runNodeContentMigrationCommand(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<NodeMigrationPreflight> {
  const { operation, origin, node, project, reviewed } = parseArguments(args)
  let body: string | undefined
  if (reviewed) {
    const previous = nodeMigrationPreflightSchema.parse(JSON.parse(await readFile(reviewed, 'utf8')))
    if (previous.nodeId !== node || previous.projectId !== project) throw new Error('The reviewed preflight belongs to another project or computer.')
    const target = nodeMigrationTargetSchema.parse({ nodeId:node, runtimeId:previous.runtimeId })
    if (operation === 'prepare') {
      if (!previous.canPrepare) throw new Error('Preparation is blocked in the reviewed preflight.')
      body = JSON.stringify(target)
    } else {
      if (!previous.canPublish || !previous.snapshot) throw new Error('Publication is blocked in the reviewed preflight.')
      body = JSON.stringify({...target, generation:previous.generation, snapshot:previous.snapshot})
    }
  }
  const cookie = await sessionCookie(environment.HGW_ADMIN_SESSION_COOKIE_FILE)
  const url = new URL(`/admin/api/deployment/project-content-migrations/${project}${operation === 'preflight' ? '' : '/'+operation}`, origin)
  url.searchParams.set('dshNode', node)
  const response = await fetch(url, {method:body ? 'POST' : 'GET', redirect:'error', cache:'no-store', headers: {cookie, origin:origin.origin,
    ...(body ? {'content-type':'application/json'} : {})}, ...(body ? {body} : {})})
  if (!response.ok) throw new Error(`The Gateway rejected project ${operation} (HTTP ${response.status}). Read the current preflight.`)
  const result = nodeMigrationPreflightSchema.parse(await response.json())
  if (result.nodeId !== node || result.projectId !== project) throw new Error('The Gateway returned another project or computer.')
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runNodeContentMigrationCommand(process.argv.slice(2), process.env), null, 2)) }
  catch (error) { console.error(error instanceof Error && error.name === 'Error' ? error.message : 'The project migration command failed. Check the Gateway and reviewed preflight.'); process.exitCode = 1 }
}
