/** Account gates retain UI destinations while refusing other origins and API routes. */
import { expect, it } from 'vitest'
import { browserReturnPath } from '../src/browser-return.ts'

it.each(['/?dshRuntime=10000000-0000-4000-8000-000000000001', '/admin/computers/10000000-0000-4000-8000-000000000001/users/7?tab=access', '/admin/users/7#runtimes'])('retains the local UI address %s', value => {
  expect(browserReturnPath(value)).toBe(value)
})

it.each([undefined, null, '', '//example.com/admin', 'https://example.com/admin', '/\\example.com/admin', '/admin\r\nLocation:evil', '/admin/api/users/7', '/api/documents/purge?id=7', '/logout', '/account/password'])('returns to the environment entry for %j', value => {
  expect(browserReturnPath(value)).toBe('/')
})
