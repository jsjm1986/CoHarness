/**
 * Structured index injections contributed by Host plugins. Rows are JSON-safe
 * data so the same table can be rendered into served HTML or transported to a
 * static worker page. Markup that cannot be represented by a row remains on
 * `tapIndex`, which runs after structured rows.
 */

/** Document region a rendered row lands in. */
export type IndexInjectionPlacement = 'head' | 'body'

/** One structured index injection row. */
export type IndexInjection =
  | { kind: 'global'; name: string; value: unknown }
  | { kind: 'script'; placement: IndexInjectionPlacement; text: string }
  | { kind: 'script-src'; placement: IndexInjectionPlacement; src: string }
  | { kind: 'style'; text: string }
  | { kind: 'html'; placement: IndexInjectionPlacement; html: string }

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function assertNever(row: never): never {
  throw new Error(`webserver: unknown index injection row ${JSON.stringify(row)}`)
}

function renderRow(row: IndexInjection): { placement: IndexInjectionPlacement; markup: string } {
  switch (row.kind) {
    case 'global': {
      const name = JSON.stringify(row.name).replaceAll('<', '\\u003c')
      const value = row.value === undefined
        ? 'undefined'
        : JSON.stringify(row.value).replaceAll('<', '\\u003c')
      return { placement: 'head', markup: `<script>globalThis[${name}] = ${value}</script>` }
    }
    case 'script':
      return { placement: row.placement, markup: `<script>${row.text}</script>` }
    case 'script-src':
      return { placement: row.placement, markup: `<script src="${escapeHtmlAttribute(row.src)}"></script>` }
    case 'style':
      return { placement: 'head', markup: `<style>${row.text}</style>` }
    case 'html':
      return { placement: row.placement, markup: row.html }
    default:
      return assertNever(row)
  }
}

function splice(html: string, at: number, markup: string): string {
  return `${html.slice(0, at)}${markup}${html.slice(at)}`
}

/**
 * Render structured rows into an index.html body.
 * @param html - the raw index.html document.
 * @param rows - structured rows collected from active Host plugins.
 * @returns the document with rows inserted into their requested regions.
 */
export function renderIndexInjections(html: string, rows: readonly IndexInjection[]): string {
  let head = ''
  let body = ''
  for (const row of rows) {
    const rendered = renderRow(row)
    if (rendered.placement === 'head') head += rendered.markup
    else body += rendered.markup
  }
  let out = html
  if (head !== '') {
    const open = /<head(?:\s[^>]*)?>/i.exec(out)
    out = open === null ? `${head}${out}` : splice(out, open.index + open[0].length, head)
  }
  if (body !== '') {
    const open = /<body(?:\s[^>]*)?>/i.exec(out)
    out = open === null ? `${out}${body}` : splice(out, open.index + open[0].length, body)
  }
  return out
}
