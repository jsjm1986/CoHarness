import { describe, expect, it } from 'vitest'
import { classifyStewardStatement } from '../src/steward-statement.ts'

describe('steward statement approval routing', () => {
  it.each([
    '/* leading /* nested */ comment */ SELECT 1',
    'VALUES (1)',
    'WITH RECURSIVE nums(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM nums WHERE n < 3) SELECT n FROM nums',
    'WITH a AS NOT MATERIALIZED (SELECT 1), b AS MATERIALIZED (SELECT * FROM a) TABLE b',
    'WITH "quoted" AS (SELECT $tag$) UPDATE x$tag$, $$) DELETE FROM x$$, \'INSERT\', E\'MERGE\\\'\') SELECT * FROM "quoted"',
    '-- comment\nWITH a AS ((SELECT (1))) SELECT * FROM a',
    'WITH a AS (WITH b AS (SELECT 1) SELECT * FROM b) SELECT * FROM a',
    'WITH a AS (',
    'WITH a AS (SELECT $tag$unterminated',
    'WITH a AS SELECT 1',
    'WITH a(a) SELECT 1',
  ])('routes %s through the read-only transaction', (sql) => {
    expect(classifyStewardStatement(sql)).toBe('read')
  })

  it.each([
    'WITH a AS (DELETE FROM t RETURNING id) SELECT * FROM a',
    'WITH values_to_add(id) AS (VALUES (1)) INSERT INTO t SELECT id FROM values_to_add',
    'WITH a AS (SELECT 1), b AS (UPDATE t SET value = 2 RETURNING value) SELECT * FROM b',
    'WITH a AS (WITH b AS (DELETE FROM t RETURNING id) SELECT * FROM b) SELECT * FROM a',
    '/* maintenance */ DELETE FROM t',
    '/* comment only */',
  ])('requires the write approval lane for %s', (sql) => {
    expect(classifyStewardStatement(sql)).toBe('write')
  })
})
