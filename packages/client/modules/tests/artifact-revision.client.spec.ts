/** Executable content identity, including the lazy chunks published by the shared compiler. */
import { describe, expect, it } from 'vitest'
import { clientChunkRevision, clientChunkRevisions, clientContentRevision, clientExecutableSource, stampClientArtifact } from '../src/artifact-revision.ts'

const entry = 'module.exports = {}\n//# sourceMappingURL=client.js.map\n'
const first = { fileName: 'client.first.js', code: 'exports.value = 1\n' }
const second = { fileName: 'client.second.js', code: 'exports.value = 2\n' }

describe('client artifact stamps', () => {
  it('preserves one trailing map reference and stamps repeated builds identically', () => {
    const stamped = stampClientArtifact(entry, [first, second])
    expect(stamped.split('\n')).toEqual([
      'module.exports = {}',
      expect.stringMatching(/^\/\/# dsh-client-chunks=v1:\{[^\n]+\}$/u),
      expect.stringMatching(/^\/\/# dsh-client-artifact=v1:[a-f\d]{64}$/u),
      '//# sourceMappingURL=client.js.map',
      '',
    ])
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
    expect(plain).toMatch(/^module.exports = \{\}\n\/\/# dsh-client-chunks=v1:\{\}\n\/\/# dsh-client-artifact=v1:[a-f\d]{64}\n$/u)
    expect(stampClientArtifact(plain, [])).toBe(plain)
    const crlf = stampClientArtifact(entry.replaceAll('\n', '\r\n'), [])
    expect(stampClientArtifact(crlf, [])).toBe(crlf)
    expect(crlf.match(/sourceMappingURL=/gu)).toHaveLength(1)
  })

  it('keeps legacy entries and marker-like string literals unmarked', () => {
    expect(clientContentRevision(Buffer.from(entry))).toBeUndefined()
    expect(clientContentRevision(Buffer.from('exports.text = "//# dsh-client-artifact=v1:bad"\n'))).toBeUndefined()
  })

  it('reads legacy v1 stamps without requiring a chunk table', () => {
    const legacy = `${entry}//# dsh-client-artifact=v1:${'a'.repeat(64)}\n`
    expect(clientContentRevision(Buffer.from(legacy))).toMatch(/^[a-f\d]{12}$/u)
    expect(clientChunkRevisions(Buffer.from(legacy))).toBeUndefined()
    expect(clientChunkRevisions(Buffer.from(entry))).toBeUndefined()
  })

  it('keeps one chunk revision across entry edits and unrelated chunk edits', () => {
    const original = clientChunkRevisions(Buffer.from(stampClientArtifact(entry, [first, second])))!
    const changed = clientChunkRevisions(Buffer.from(stampClientArtifact('exports.changed = true\n', [
      first, { ...second, code: 'exports.value = 3\n' },
    ])))!
    expect(Object.keys(original)).toEqual(['client.first.js', 'client.second.js'])
    expect(original['client.first.js']).toBe(clientChunkRevision(first.code))
    expect(changed['client.first.js']).toBe(original['client.first.js'])
    expect(changed['client.second.js']).not.toBe(original['client.second.js'])
  })

  it('excludes generated debug trailers from a chunk executable revision', () => {
    const revision = clientChunkRevision(first.code)
    for (const trailers of [
      '//# sourceMappingURL=first.js.map\n',
      '//# sourceURL=first.js\n',
      '//# sourceMappingURL=second.js.map\n//# sourceURL=second.js\n',
      '//# sourceURL=second.js\n//# sourceMappingURL=second.js.map\n',
    ]) expect(clientChunkRevision(first.code + trailers)).toBe(revision)
    expect(clientChunkRevision(first.code.trimEnd())).toBe(revision)
  })

  it.each(['sourceURL', 'sourceMappingURL'])('preserves an inline %s string through both generated debug trailers', (directive) => {
    const code = `const comment = \`//# ${directive}=\` + 'template.js'; module.exports = { comment };\n`
    for (const trailers of [
      '',
      '//# sourceMappingURL=client.preview.js.map\n',
      '//# sourceURL=client.preview.js\n//# sourceMappingURL=client.preview.js.map\n',
      '//# sourceMappingURL=client.preview.js.map\n//# sourceURL=client.preview.js\n',
    ]) {
      expect(clientExecutableSource(code + trailers)).toBe(code)
      expect(clientChunkRevision(code + trailers)).toBe(clientChunkRevision(code))
    }
  })

  it('rejects duplicate or unpublished chunk filenames from the compiler', () => {
    expect(() => stampClientArtifact(entry, [first, first])).toThrow('duplicate client artifact chunk')
    expect(() => stampClientArtifact(entry, [{ ...first, fileName: '../client.first.js' }])).toThrow('chunks')
  })

  it.each([
    'v2:{}', 'v1:null', 'v1:[]', 'v1:{',
    'v1:{"client.first.js":"short"}',
    `v1:{"../client.first.js":"${'a'.repeat(64)}"}`,
    `v1:{"client.first.js":"${'a'.repeat(64)}","client.first.js":"${'b'.repeat(64)}"}`,
    'v1:{}\n//# dsh-client-chunks=v1:{}',
  ])('rejects malformed, unsupported or duplicate chunk tables: %s', (table) => {
    const invalid = `module.exports = {}\n//# dsh-client-chunks=${table}\n//# dsh-client-artifact=v1:${'a'.repeat(64)}\n`
    expect(() => clientContentRevision(Buffer.from(invalid))).toThrow('chunk')
    expect(() => clientChunkRevisions(Buffer.from(invalid))).toThrow('chunk')
    expect(() => stampClientArtifact(invalid, [])).toThrow('chunk')
  })

  it('rejects a standalone chunk table without a completed artifact stamp', () => {
    const invalid = `${entry}//# dsh-client-chunks=v1:{}\n`
    expect(() => clientContentRevision(Buffer.from(invalid))).toThrow('invalid client chunk table')
    expect(() => clientChunkRevisions(Buffer.from(invalid))).toThrow('invalid client chunk table')
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
