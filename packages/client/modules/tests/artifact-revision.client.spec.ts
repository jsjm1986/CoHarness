/** Executable content identity, including the lazy chunks published by the shared compiler. */
import { describe, expect, it } from 'vitest'
import { clientContentRevision, stampClientArtifact } from '../src/artifact-revision.ts'

const entry = 'module.exports = {}\n//# sourceMappingURL=client.js.map\n'
const first = { fileName: 'client.first.js', code: 'exports.value = 1\n' }
const second = { fileName: 'client.second.js', code: 'exports.value = 2\n' }

describe('client artifact stamps', () => {
  it('preserves one trailing map reference and stamps repeated builds identically', () => {
    const stamped = stampClientArtifact(entry, [first, second])
    expect(stamped).toMatch(/^module.exports = \{\}\n\/\/# dsh-client-artifact=v1:[a-f\d]{64}\n\/\/# sourceMappingURL=client.js.map\n$/u)
    expect(stampClientArtifact(stamped, [second, first])).toBe(stamped)
    expect(clientContentRevision(Buffer.from(stamped))).toMatch(/^[a-f\d]{12}$/u)
  })

  it('changes identity for entry edits, lazy code edits, renamed chunks and removed chunks', () => {
    const original = stampClientArtifact(entry, [first, second])
    for (const changed of [
      stampClientArtifact(entry.replace('{}', '{ changed: true }'), [first, second]),
      stampClientArtifact(entry, [{ ...first, code: 'exports.value = 3\n' }, second]),
      stampClientArtifact(entry, [{ ...first, fileName: 'client.renamed.js' }, second]),
      stampClientArtifact(entry, [first]),
    ]) {
      expect(clientContentRevision(Buffer.from(changed))).not.toBe(clientContentRevision(Buffer.from(original)))
    }
  })

  it('supports entries without maps and CRLF map trailers', () => {
    const empty = stampClientArtifact('', [])
    expect(stampClientArtifact(empty, [])).toBe(empty)
    expect(clientContentRevision(Buffer.from(empty))).toMatch(/^[a-f\d]{12}$/u)
    const plain = stampClientArtifact('module.exports = {}', [])
    expect(plain).toMatch(/^module.exports = \{\}\n\/\/# dsh-client-artifact=v1:[a-f\d]{64}\n$/u)
    expect(stampClientArtifact(plain, [])).toBe(plain)
    const crlf = stampClientArtifact(entry.replaceAll('\n', '\r\n'), [])
    expect(stampClientArtifact(crlf, [])).toBe(crlf)
    expect(crlf.match(/sourceMappingURL=/gu)).toHaveLength(1)
  })

  it('keeps legacy entries and marker-like string literals unmarked', () => {
    expect(clientContentRevision(Buffer.from(entry))).toBeUndefined()
    expect(clientContentRevision(Buffer.from('exports.text = "//# dsh-client-artifact=v1:bad"\n'))).toBeUndefined()
  })

  it('preserves marker-like multiline source text outside the artifact footer', () => {
    const source = 'exports.example = `\n//# dsh-client-artifact=v2:documentation\n`;\n'
    expect(clientContentRevision(Buffer.from(source))).toBeUndefined()
    const stamped = stampClientArtifact(source, [])
    expect(stamped).toContain(source.trimEnd())
    expect(stampClientArtifact(stamped, [])).toBe(stamped)
    expect(clientContentRevision(Buffer.from(stamped))).toMatch(/^[a-f\d]{12}$/u)
  })

  it.each(['v2:' + 'a'.repeat(64), 'v1:short', 'v1:' + 'G'.repeat(64), 'v1:' + 'a'.repeat(64) + '\n//# dsh-client-artifact=v1:' + 'b'.repeat(64)])(
    'rejects malformed, unsupported or duplicate reserved stamps: %s', (stamp) => {
      const invalid = `${entry}//# dsh-client-artifact=${stamp}\n`
      expect(() => clientContentRevision(Buffer.from(invalid))).toThrow('invalid client artifact stamp')
      expect(() => stampClientArtifact(invalid, [])).toThrow('invalid client artifact stamp')
    },
  )
})
