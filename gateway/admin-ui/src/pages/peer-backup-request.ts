/** Authenticated transport shared by peer-backup and local recovery administration. */

/** Send a same-origin backup administration request without retaining credentials or results.
 * @param suffix - resource below the peer-backup Admin API.
 * @param method - HTTP method.
 * @param data - optional JSON mutation body.
 * @param signal - cancellation for an owned read.
 * @returns the decoded response; rejected requests retain the server's error code.
 */
export async function requestPeerBackup<T>(suffix: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/admin/api/peer-backups' + suffix, {
    method, credentials: 'same-origin', cache: 'no-store', signal,
    ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  })
  const result = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(result.error ?? String(response.status))
  return result
}
