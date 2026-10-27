/** Content identity for compiler-published client entries and their lazy JavaScript chunks. */
import { createHash } from 'node:crypto'
import { parseChunkRevisions } from './client/manifest.ts'

const MARKER = '//# dsh-client-artifact='
const CHUNKS_MARKER = '//# dsh-client-chunks='
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/u
const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=[^\r\n]+(?:\r?\n)?$/u

/** One executable sibling emitted by the client compiler. */
export interface ClientArtifactChunk {
  /** Package-local output filename. */
  readonly fileName: string
  /** Exact emitted JavaScript, including its map reference when present. */
  readonly code: string
}

function trailingLine(code: string, end: number): { start: number; text: string } {
  const newline = code.endsWith('\n', end) ? end - 1 : end
  const contentEnd = newline > 0 && code[newline - 1] === '\r' ? newline - 1 : newline
  const start = contentEnd === 0 ? 0 : code.lastIndexOf('\n', contentEnd - 1) + 1
  return { start, text: code.slice(start, contentEnd) }
}

function declaredFooter(code: string): { start: number; end: number; chunks?: Record<string, string> } | undefined {
  let end = code.length
  let line = trailingLine(code, end)
  if (line.text.startsWith('//# sourceMappingURL=')) {
    end = line.start
    line = trailingLine(code, end)
  }
  if (!line.text.startsWith(MARKER)) {
    if (line.text.startsWith(CHUNKS_MARKER)) throw new Error('client-modules: invalid client chunk table')
    return undefined
  }
  if (!/^\/\/# dsh-client-artifact=v1:[a-f\d]{64}$/u.test(line.text)
    || trailingLine(code, line.start).text.startsWith(MARKER)) {
    throw new Error('client-modules: invalid client artifact stamp')
  }
  const previous = trailingLine(code, line.start)
  if (!previous.text.startsWith(CHUNKS_MARKER)) return { start: line.start, end }
  const prefix = `${CHUNKS_MARKER}v1:`
  if (!previous.text.startsWith(prefix)) throw new Error('client-modules: invalid client chunk table')
  let value: unknown
  try {
    value = JSON.parse(previous.text.slice(prefix.length))
  } catch (cause) {
    throw new Error('client-modules: invalid client chunk table', { cause })
  }
  const chunks = parseChunkRevisions('client artifact', value)
  const before = trailingLine(code, previous.start).text
  if (before.startsWith(CHUNKS_MARKER) || before.startsWith(MARKER)) {
    throw new Error('client-modules: invalid client chunk table')
  }
  const ordered = Object.fromEntries(Object.entries(chunks)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))))
  if (JSON.stringify(ordered) !== previous.text.slice(prefix.length)) throw new Error('client-modules: invalid client chunk table')
  return { start: previous.start, end, chunks }
}

/**
 * Remove generated debug trailers and normalize the executable's trailing newline.
 * @param code - emitted JavaScript, including optional sourceURL and sourceMappingURL trailers.
 * @returns executable text used by chunk identity and HTTP response construction.
 */
export function clientExecutableSource(code: string): string {
  const source = code.replace(SOURCE_URL_TRAILER, '').replace(SOURCE_MAP_TRAILER, '').replace(SOURCE_URL_TRAILER, '')
  return source.endsWith('\n') ? source : `${source}\n`
}

/**
 * Identify one lazy executable without reading or hashing its debug map.
 * @param code - emitted JavaScript, including optional debug trailers.
 * @returns the version-domain SHA-256 revision shared by the compiler and lazy Host read.
 */
export function clientChunkRevision(code: string): string {
  return createHash('sha256').update('dsh-client-chunk-v1\0').update(clientExecutableSource(code)).digest('hex')
}

/**
 * Read a completed entry's optional chunk table without opening sibling files.
 * @param bundle - exact entry bytes captured by the Host.
 * @returns chunk revisions, or undefined for legacy entries without a table.
 * @throws {Error} when a reserved footer is malformed, duplicated or unsupported.
 */
export function clientChunkRevisions(bundle: Buffer): Record<string, string> | undefined {
  return declaredFooter(bundle.toString('utf8'))?.chunks
}

/**
 * Mark a completed client entry with the deterministic identity of its executable siblings.
 * Source maps retain their trailing reference and do not participate in executable identity.
 * @param entry - emitted entry bytes decoded as UTF-8, including any source-map trailer.
 * @param chunks - completed sibling JavaScript chunks; their order is immaterial.
 * @returns the entry with one versioned content stamp and one trailing newline.
 * @throws {Error} when an existing reserved footer is malformed, duplicated or unsupported.
 */
export function stampClientArtifact(entry: string, chunks: readonly ClientArtifactChunk[]): string {
  const footer = declaredFooter(entry)
  const hash = createHash('sha256').update('dsh-client-chunks-v1\0')
  const revisions: Record<string, string> = {}
  for (const chunk of [...chunks].sort((a, b) => Buffer.compare(Buffer.from(a.fileName), Buffer.from(b.fileName)))) {
    if (Object.hasOwn(revisions, chunk.fileName)) throw new Error('client-modules: duplicate client artifact chunk')
    revisions[chunk.fileName] = clientChunkRevision(chunk.code)
    hash.update(`${String(Buffer.byteLength(chunk.fileName))}:`).update(chunk.fileName)
    hash.update(`${String(Buffer.byteLength(chunk.code))}:`).update(chunk.code)
  }
  parseChunkRevisions('client artifact', revisions)
  const clean = footer === undefined ? entry : entry.slice(0, footer.start) + entry.slice(footer.end)
  const map = /(?:^|\r?\n)(\/\/# sourceMappingURL=[^\r\n]*)\r?\n?$/u.exec(clean)
  const body = map === null ? clean : clean.slice(0, map.index)
  const trailer = map?.[1]
  return `${body.trimEnd()}\n${CHUNKS_MARKER}v1:${JSON.stringify(revisions)}\n${MARKER}v1:${hash.digest('hex')}\n${trailer === undefined ? '' : `${trailer}\n`}`
}

/**
 * Resolve a marked entry's content revision without reading sibling files.
 * Unmarked artifacts keep the registry's legacy filesystem revision policy.
 * @param bundle - exact entry bytes captured by the registry.
 * @returns the content revision, or undefined for an unmarked artifact.
 * @throws {Error} when a reserved footer is malformed, duplicated or unsupported.
 */
export function clientContentRevision(bundle: Buffer): string | undefined {
  if (!bundle.includes(MARKER) && !bundle.includes(CHUNKS_MARKER)) return undefined
  if (declaredFooter(bundle.toString('utf8')) === undefined) return undefined
  return createHash('sha1').update('dsh-client-content-v1\0').update(bundle).digest('hex').slice(0, 12)
}
