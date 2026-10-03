/** Every @Remote-exposed endpoint must be classified for project participants. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SERVICE_API } from '@deepseek-ai/dsh-tool-cordis/src/api-catalog.ts'
import { REMOTE_SESSION_POLICIES } from '../src/api/remote-session-routing.ts'
import {
  ADMIN_TERMINAL_ENDPOINTS,
  PROJECT_TYPERT_MANAGER_CONFIGURATION,
  PROJECT_TYPERT_PERSONAL_CONFIGURATION,
  PROJECT_TYPERT_PROCESS_WIDE_OPERATIONS,
  PROJECT_TYPERT_PROCESS_WIDE_READS,
  PROJECT_TYPERT_REGISTRY_AUTHORIZED,
  USER_TERMINAL_ENDPOINTS,
} from '../src/api-proxy.ts'

const REMOTE_SIGNATURE = /^@Remote(?:\('([^']+)'\)|\(.*?\))?\s*(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*\(/
const SERVICE_NAMESPACE = /super\(ctx, '([^']+)'(?:,\s*\{\s*namespace:\s*'([^']+)'\s*\})?\s*\)/

/** Parse the wire name out of a catalog signature; an explicit alias wins. */
function remoteEndpoint(namespace: string, signature: string): string | undefined {
  const match = REMOTE_SIGNATURE.exec(signature)
  if (match === null) return undefined
  return `${namespace}/${match[1] ?? match[2]}`
}

const REMOTE_SOURCE = /@Remote(?:\('([^']+)'\)|\([\s\S]*?\))?\s*(?:public\s+|static\s+|async\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(/g

interface BoundService {
  /** Wire namespace — the explicit option wins over the service key. */
  namespace: string
  /** File declaring the binding, for catalog-absent @Remote extraction. */
  path: string
}

/** Wire namespaces declared by TypertRemoteService bindings, keyed by catalog service key. */
function boundServices(root: string): Map<string, BoundService> {
  const services = new Map<string, BoundService>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'tests' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.includes('.spec.')) {
        const source = readFileSync(path, 'utf8')
        for (const match of source.matchAll(new RegExp(SERVICE_NAMESPACE, 'g'))) {
          services.set(match[1]!, { namespace: match[2] ?? match[1]!, path })
        }
      }
    }
  }
  for (const plane of ['packages', 'apps']) walk(join(root, plane))
  return services
}

/** Extract @Remote wire names from a service source the catalog does not project. */
function sourceRemotes(service: BoundService): string[] {
  const remotes: string[] = []
  for (const match of readFileSync(service.path, 'utf8').matchAll(REMOTE_SOURCE)) {
    remotes.push(`${service.namespace}/${match[1] ?? match[2]}`)
  }
  return remotes
}

describe('remote endpoint policy coverage', () => {
  const classified = new Set<string>([
    ...Object.keys(REMOTE_SESSION_POLICIES),
    ...PROJECT_TYPERT_PROCESS_WIDE_READS,
    ...PROJECT_TYPERT_REGISTRY_AUTHORIZED,
    ...PROJECT_TYPERT_MANAGER_CONFIGURATION,
    ...PROJECT_TYPERT_PERSONAL_CONFIGURATION,
    ...PROJECT_TYPERT_PROCESS_WIDE_OPERATIONS,
    ...ADMIN_TERMINAL_ENDPOINTS,
    ...USER_TERMINAL_ENDPOINTS,
  ])

  const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
  const bound = boundServices(repoRoot)
  const endpoints = SERVICE_API.flatMap(service =>
    service.methods
      .map(method => remoteEndpoint(bound.get(service.key)?.namespace ?? service.key, method.signature))
      .filter((endpoint): endpoint is string => endpoint !== undefined),
  )
  // Services the catalog projection does not list still authorize through the
  // same table; recover their wire names from the binding's own source file.
  const catalogKeys = new Set(SERVICE_API.map(service => service.key))
  for (const [key, service] of bound) {
    if (!catalogKeys.has(key)) endpoints.push(...sourceRemotes(service))
  }

  it('discovers a non-empty Remote surface from the generated catalog', () => {
    expect(endpoints.length).toBeGreaterThan(20)
  })

  it.each(endpoints.map(endpoint => [endpoint] as const))(
    'classifies %s for project participants',
    (endpoint) => {
      expect(classified.has(endpoint), `${endpoint} has no project-scope policy`).toBe(true)
    },
  )

  it.each([...classified])('policy entry %s resolves to a catalog endpoint', (endpoint) => {
    expect(endpoints.includes(endpoint), `policy entry ${endpoint} names no generated endpoint`).toBe(true)
  })
})
