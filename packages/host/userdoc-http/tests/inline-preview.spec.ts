/** Authenticated runnable document previews retain streaming bytes and type-specific framing policy. */
import { expect, it, onTestFinished } from 'vitest'
import { startNativePreviewFixture } from './native-preview-fixture.ts'

it('permits only inline PDFs to be framed by their own origin through the assembled Host', async () => {
  const fixture = await startNativePreviewFixture()
  onTestFinished(fixture.close)
  const unauthorized = await fetch(fixture.documents.pdf.url)
  expect(unauthorized.status).toBe(401)
  await unauthorized.arrayBuffer()
  const login = await fetch(fixture.authenticatedUrl, { redirect: 'manual' })
  expect(login.status).toBe(303)
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('fixture login did not return its private session cookie')
  const rows = []
  for (const [kind, document] of Object.entries(fixture.documents)) {
    const response = await fetch(document.url, { headers: { cookie } })
    const bytes = await response.arrayBuffer()
    expect(response.status).toBe(200)
    expect(bytes.byteLength).toBe(document.bytes)
    expect(response.headers.get('content-length')).toBe(String(document.bytes))
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('private, no-store, no-transform')
    rows.push({
      kind,
      type: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      policy: response.headers.get('content-security-policy'),
    })
  }
  const download = await fetch(fixture.documents.pdf.downloadUrl, { headers: { cookie } })
  expect(download.headers.get('content-disposition')).toContain('attachment')
  expect(download.headers.has('content-security-policy')).toBe(false)
  expect((await download.arrayBuffer()).byteLength).toBe(fixture.documents.pdf.bytes)
  const head = await fetch(fixture.documents.pdf.url, { method: 'HEAD', headers: { cookie } })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-length')).toBe(String(fixture.documents.pdf.bytes))
  expect(head.headers.get('content-security-policy')).toBe(rows[0]!.policy)
  expect((await head.arrayBuffer()).byteLength).toBe(0)
  expect(rows).toMatchInlineSnapshot(`
    [
      {
        "disposition": "inline",
        "kind": "pdf",
        "policy": "default-src 'none'; img-src 'self' data:; frame-ancestors 'self'; sandbox",
        "type": "application/pdf",
      },
      {
        "disposition": "inline",
        "kind": "fakePdf",
        "policy": "default-src 'none'; img-src 'self' data:; frame-ancestors 'self'; sandbox",
        "type": "application/pdf",
      },
      {
        "disposition": "inline",
        "kind": "html",
        "policy": "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'; sandbox",
        "type": "text/html",
      },
      {
        "disposition": "inline",
        "kind": "svg",
        "policy": "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'; sandbox",
        "type": "image/svg+xml",
      },
      {
        "disposition": "inline",
        "kind": "text",
        "policy": "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'; sandbox",
        "type": "text/plain",
      },
    ]
  `)
})
