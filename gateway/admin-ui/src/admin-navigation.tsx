/** Route links within the computer selected by the matching Admin page. */
import { Link, useParams, type LinkProps } from 'react-router-dom'

/** @returns A resolver for absolute Admin page paths within the matched computer. */
export function useAdminPath(): (path: string) => string {
  const { nodeId } = useParams<'nodeId'>()
  return path => nodeId === undefined ? path : path === '/' ? `/computers/${nodeId}` : `/computers/${nodeId}${path}`
}

/** @param props - Link properties with an absolute Admin page path. @returns A link scoped to the matched computer. */
export function AdminLink({ to, ...props }: Omit<LinkProps, 'to'> & { to: string }) {
  const adminPath = useAdminPath()
  return <Link {...props} to={adminPath(to)} />
}
