// @vitest-environment jsdom
/** Independent HTTP previews own bounded reads and never publish obsolete bytes. */
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PdfPreview } from '../src/client/components/PdfPreview.tsx'
import type { PdfBodyProps } from '../src/client/pdf/pdf.tsx'
import { en } from '../src/client/pdf/locales.ts'

const observed = vi.hoisted(() => ({ bodies: [] as PdfBodyProps[] }))
vi.mock('../src/client/pdf/pdf.tsx', () => ({ PdfBody: (props: PdfBodyProps) => {
  observed.bodies.push(props)
  return <pre data-testid="pdf">{new TextDecoder().decode(props.data)}</pre>
} }))

afterEach(async () => { cleanup(); await vi.dynamicImportSettled(); vi.unstubAllGlobals(); observed.bodies.length = 0 })
const t = makeTranslate(en)
const initial = { sourceUrl: '/api/documents/content?id=one&dshPrincipal=4', documentKey: 'personal:one:v1', maxBytes: 20, t }

it('reads complete bytes, retains local view state on rerender and aborts the body on unmount', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('PDF one'))
  vi.stubGlobal('fetch', request)
  const h = render(<PdfPreview {...initial} />)
  expect(h.getByRole('status').textContent).toBe(en.loading)
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF one') })
  const first = observed.bodies.at(-1)!
  first.view.page = 3
  h.rerender(<PdfPreview {...initial} />)
  expect(observed.bodies.at(-1)!.view).toBe(first.view)
  expect(observed.bodies.at(-1)!.view.page).toBe(3)
  expect(request).toHaveBeenCalledExactlyOnceWith(initial.sourceUrl, { signal: first.signal })
  h.unmount()
  expect(first.signal.aborted).toBe(true)
})

it('resets page preferences and discards a late response after the content identity changes', async () => {
  const pending = Promise.withResolvers<Response>()
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('PDF one')).mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce(new Response('PDF three'))
  vi.stubGlobal('fetch', request)
  const h = render(<PdfPreview {...initial} />)
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF one') })
  const first = observed.bodies.at(-1)!
  first.view.page = 3
  h.rerender(<PdfPreview {...initial} documentKey="personal:one:v2" />)
  expect(first.signal.aborted).toBe(true)
  expect(h.queryByTestId('pdf')).toBeNull()
  await act(async () => { await vi.dynamicImportSettled() })
  h.rerender(<PdfPreview {...initial} documentKey="personal:one:v3" />)
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF three') })
  expect(observed.bodies.at(-1)!.view.page).toBe(1)
  expect(request.mock.calls[1]![1]!.signal!.aborted).toBe(true)
  await act(async () => { pending.resolve(new Response('PDF obsolete')) })
  expect(h.getByTestId('pdf').textContent).toBe('PDF three')
})

it('does not request an empty document', () => {
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', request)
  const h = render(<PdfPreview {...initial} maxBytes={0} />)
  expect(h.getByRole('alert').textContent).toBe(en.unsupported)
  expect(h.queryByRole('button', { name: en.retry })).toBeNull()
  expect(request).not.toHaveBeenCalled()
  expect(observed.bodies).toHaveLength(0)
})

it.each(['network', 'http', 'empty'] as const)('offers explicit retry after a %s failure without exposing the private URL', async (failure) => {
  const request = vi.fn<typeof fetch>()
  if (failure === 'network') request.mockRejectedValueOnce(new Error(`Failed to fetch ${initial.sourceUrl}`))
  else request.mockResolvedValueOnce(new Response(failure === 'empty' ? '' : 'denied', { status: failure === 'http' ? 403 : 200 }))
  request.mockResolvedValueOnce(new Response('PDF recovered'))
  vi.stubGlobal('fetch', request)
  const h = render(<PdfPreview {...initial} />)
  await waitFor(() => { expect(h.getByRole('alert').textContent).toContain(en.unsupported) })
  expect(h.container.textContent).not.toContain('dshPrincipal')
  expect(observed.bodies).toHaveLength(0)
  fireEvent.click(h.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF recovered') })
  expect(request).toHaveBeenCalledTimes(2)
})

it('cancels an oversized stream without starting the PDF body', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(21)) }, cancel })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
  const h = render(<PdfPreview {...initial} />)
  await waitFor(() => { expect(h.getByRole('alert')).toBeTruthy() })
  expect(cancel).toHaveBeenCalledOnce()
  expect(observed.bodies).toHaveLength(0)
})

it('cancels a pending network body when the reader closes', async () => {
  const cancel = vi.fn()
  const reading = Promise.withResolvers<undefined>()
  const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(undefined) }, cancel })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
  const h = render(<PdfPreview {...initial} />)
  await act(async () => { await reading.promise })
  h.unmount()
  await waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
  expect(observed.bodies).toHaveLength(0)
})

it('starts a fresh read after StrictMode releases its first effect lifetime', async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('PDF strict'))
  vi.stubGlobal('fetch', request)
  const h = render(<StrictMode><PdfPreview {...initial} /></StrictMode>)
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF strict') })
  expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true)
  expect(observed.bodies.at(-1)!.signal.aborted).toBe(false)
})
