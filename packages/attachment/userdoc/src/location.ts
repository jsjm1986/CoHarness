/** Browser addressing for computer-local document stores. */
import type { UserDocScope } from './types.ts'

/**
 * Bind an ordinary document route to its explicit storage location.
 * @param path - existing document HTTP path and query.
 * @param scope - captured account/project location; independent Hosts may omit it.
 * @returns a relative document URL; requests unrelated to documents retain their original address.
 */
export function userDocLocationUrl(path: string, scope?: UserDocScope): string {
  if (scope?.nodeId === undefined) return path
  const url = new URL(path, 'http://documents.invalid'), root = '/api/documents'
  if (url.origin !== 'http://documents.invalid' || !url.pathname.startsWith(root)) return path
  if (url.pathname === `${root}/overview` || url.pathname.startsWith(`${root}/transfer`) && !url.pathname.startsWith(`${root}/transfer/uploads`)) {
    url.pathname = `/account${url.pathname}${url.pathname === `${root}/transfer` ? '/copy' : ''}`
    return `${url.pathname}${url.search}`
  }
  if (!url.pathname.startsWith(`${root}/scope`) && !url.pathname.startsWith(`${root}/transfer`)) {
    url.pathname = url.pathname.startsWith(`${root}/uploads`)
      ? `${root}/transfer${url.pathname.slice(root.length)}` : `${root}/scope${url.pathname.slice(root.length)}`
  }
  if (!url.searchParams.has('scope')) url.searchParams.set('scope', scope.kind === 'personal' ? 'personal' : `project:${String(scope.projectId)}`)
  if (!url.searchParams.has('dshNode')) url.searchParams.set('dshNode', scope.nodeId)
  return `${url.pathname}${url.search}`
}
