import { describe, expect, it } from 'vitest'
import { isReadOnly, statementPreview } from '../src/query.ts'

describe('isReadOnly', () => {
  it('accepts SELECT-family heads', () => {
    for (const sql of [
      'SELECT 1',
      '  select id from harness.users',
      '-- comment\nSELECT * FROM t',
      '/* block */ WITH x AS (SELECT 1) SELECT * FROM x',
      'VALUES (1,2)',
      'TABLE harness.projects',
      'SHOW server_version',
      'EXPLAIN SELECT 1',
    ]) {
      expect(isReadOnly(sql), sql).toBe(true)
    }
  })

  it('rejects writes, DDL, and administrative statements', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a=1',
      'DELETE FROM t',
      'ALTER TABLE t ADD COLUMN x int',
      'CREATE TABLE t(a int)',
      'DROP TABLE t',
      'GRANT SELECT ON t TO r',
      'SET statement_timeout=1',
      'TRUNCATE t',
      'COPY t FROM STDIN',
    ]) {
      expect(isReadOnly(sql), sql).toBe(false)
    }
  })

  it('reads a quoted semicolon as part of one SELECT, not a second statement', () => {
    // Statement splitting is not the classifier's job: the Gateway executes
    // through the extended protocol, which physically rejects extra
    // statements regardless of how the head was classified.
    expect(isReadOnly(`SELECT '; DROP TABLE t'`)).toBe(true)
  })

  it('rejects comment-prefixed writes', () => {
    expect(isReadOnly('-- x\n-- y\nUPDATE t SET a=1')).toBe(false)
    expect(isReadOnly('/* a */ /* b */ DELETE FROM t')).toBe(false)
  })

  it('rejects empty statements as non-read', () => {
    expect(isReadOnly('')).toBe(false)
    expect(isReadOnly('   -- only a comment')).toBe(false)
  })
})

describe('statementPreview', () => {
  it('keeps one trimmed line and truncates long heads', () => {
    expect(statementPreview('  -- c\nUPDATE t SET a=1\nRETURNING *')).toBe('UPDATE t SET a=1')
    const long = `UPDATE t SET ${'x'.repeat(300)}=1`
    expect(statementPreview(long).length).toBe(160)
    expect(statementPreview(long).endsWith('...')).toBe(true)
  })
})
