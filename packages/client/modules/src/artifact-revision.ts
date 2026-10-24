/** Content identity for compiler-published client entries and their lazy JavaScript chunks. */
import { createHash } from 'node:crypto'

const MARKER = '//# dsh-client-artifact='

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

function declaredFooter(code: string): { start: number; end: number } | undefined {
  let end = code.length
  let line = trailingLine(code, end)
  if (line.text.startsWith('//# sourceMappingURL=')) {
    end = line.start
    line = trailingLine(code, end)
  }
  if (!line.text.startsWith(MARKER)) return undefined
  if (!/^\/\/# dsh-client-artifact=v1:[a-f\d]{64}$/u.test(line.text)
    || trailingLine(code, line.start).text.startsWith(MARKER)) {
    throw new Error('client-modules: invalid client artifact stamp')
  }
  return { start: line.start, end }
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
  for (const chunk of [...chunks].sort((a, b) => Buffer.compare(Buffer.from(a.fileName), Buffer.from(b.fileName)))) {
    hash.update(`${String(Buffer.byteLength(chunk.fileName))}:`).update(chunk.fileName)
    hash.update(`${String(Buffer.byteLength(chunk.code))}:`).update(chunk.code)
  }
  const clean = footer === undefined ? entry : entry.slice(0, footer.start) + entry.slice(footer.end)
  const map = /(?:^|\r?\n)(\/\/# sourceMappingURL=[^\r\n]*)\r?\n?$/u.exec(clean)
  const body = map === null ? clean : clean.slice(0, map.index)
  const trailer = map?.[1]
  return `${body.trimEnd()}\n${MARKER}v1:${hash.digest('hex')}\n${trailer === undefined ? '' : `${trailer}\n`}`
}

/**
 * Resolve a marked entry's content revision without reading sibling files.
 * Unmarked artifacts keep the registry's legacy filesystem revision policy.
 * @param bundle - exact entry bytes captured by the registry.
 * @returns the content revision, or undefined for an unmarked artifact.
 * @throws {Error} when a reserved footer is malformed, duplicated or unsupported.
 */
export function clientContentRevision(bundle: Buffer): string | undefined {
  if (!bundle.includes(MARKER)) return undefined
  if (declaredFooter(bundle.toString('utf8')) === undefined) return undefined
  return createHash('sha1').update('dsh-client-content-v1\0').update(bundle).digest('hex').slice(0, 12)
}
