import { describe, expect, it } from 'vitest'
import { classifyStewardStatement, hasStewardReadDeniedIdentifier } from '../src/steward-statement.ts'

describe('steward statement approval routing', () => {
  it.each([
    '/* leading /* nested */ comment */ SELECT 1',
    'SELECT U&"col" FROM t',
    'VALUES (1)',
    'WITH RECURSIVE nums(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM nums WHERE n < 3) SELECT n FROM nums',
    'WITH RECURSIVE nums(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM nums WHERE n < 3) SEARCH DEPTH FIRST BY n SET ord CYCLE n SET is_cycle USING path SELECT n FROM nums',
    'WITH a AS NOT MATERIALIZED (SELECT 1), b AS MATERIALIZED (SELECT * FROM a) TABLE b',
    'WITH "quoted" AS (SELECT $tag$) UPDATE x$tag$, $$) DELETE FROM x$$, \'INSERT\', E\'MERGE\\\'\') SELECT * FROM "quoted"',
    '-- comment\nWITH a AS ((SELECT (1))) SELECT * FROM a',
    'WITH a AS (WITH b AS (SELECT 1) SELECT * FROM b) SELECT * FROM a',
    'WITH a AS (',
    'WITH a AS (SELECT $tag$unterminated',
    'WITH a AS SELECT 1',
    'WITH a(a) SELECT 1',
    'WITH a AS (SELECT 1) SEARCH BREADTH FIRST',
    'EXPLAIN SELECT 1',
    'EXPLAIN UPDATE t SET value = 1',
    'EXPLAIN (ANALYZE OFF) DELETE FROM t',
    'EXPLAIN (ANALYZE FALSE, BUFFERS) UPDATE t SET value = 1',
    'EXPLAIN (ANALYSE 0) DELETE FROM t',
    'EXPLAIN ANALYZE SELECT 1',
    'EXPLAIN VERBOSE ANALYSE SELECT 1',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT 1',
    'EXPLAIN (ANALYZE TRUE) WITH a AS (SELECT 1) SELECT * FROM a',
  ])('routes %s through the read-only transaction', (sql) => {
    expect(classifyStewardStatement(sql)).toBe('read')
  })

  it.each([
    'WITH a AS (DELETE FROM t RETURNING id) SELECT * FROM a',
    'WITH values_to_add(id) AS (VALUES (1)) INSERT INTO t SELECT id FROM values_to_add',
    'WITH a AS (SELECT 1), b AS (UPDATE t SET value = 2 RETURNING value) SELECT * FROM b',
    'WITH a AS (WITH b AS (DELETE FROM t RETURNING id) SELECT * FROM b) SELECT * FROM a',
    'WITH RECURSIVE nums(n) AS (VALUES (1)) SEARCH DEPTH FIRST BY n SET ord, d AS (DELETE FROM t RETURNING id) SELECT * FROM d',
    'WITH RECURSIVE nums(n) AS (VALUES (1)) CYCLE n SET is_cycle USING path DELETE FROM t',
    'WITH RECURSIVE nums(n) AS (VALUES (1)) SEARCH BREADTH FIRST BY n SET ord CYCLE n SET is_cycle TO \'Y\' DEFAULT \'N\' USING path, d AS (UPDATE t SET value = 1 RETURNING id) SELECT * FROM d',
    'EXPLAIN ANALYZE UPDATE t SET value = 1',
    'EXPLAIN VERBOSE ANALYSE DELETE FROM t',
    'EXPLAIN (ANALYZE) DELETE FROM t',
    'EXPLAIN (BUFFERS, ANALYZE TRUE) WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d',
    'EXPLAIN (ANALYZE 1) INSERT INTO t VALUES (1)',
    'EXPLAIN (ANALYZE)',
    '/* maintenance */ DELETE FROM t',
    '/* comment only */',
  ])('requires the write approval lane for %s', (sql) => {
    expect(classifyStewardStatement(sql)).toBe('write')
  })
})

describe('steward read-lane identifier screening', () => {
  const denied = new Set(['pg_sleep', 'pg_read_file', 'pg_terminate_backend', 'set_config'])

  it.each([
    'SELECT pg_sleep(1)',
    'SELECT pg_catalog.PG_SLEEP(1)',
    'SELECT "pg_catalog"."pg_sleep"(1)',
    "SELECT '/* ', pg_sleep(1), ' */'",
    "SELECT '--' || chr(10), pg_read_file('/etc/passwd')",
    "SELECT '$$', pg_terminate_backend(1), '$$'",
    "SELECT E'\\'', pg_sleep(1), ''",
    'SELECT U&"pg_\\0073leep"(1)',
    'SELECT u&"any_escaped_ident"(1)',
  ])('flags denied or obfuscated identifier in %s', (sql) => {
    expect(hasStewardReadDeniedIdentifier(sql, denied)).toBe(true)
  })

  it.each([
    "SELECT 'pg_terminate_backend' AS name -- pg_sleep(1)",
    'SELECT /* outer /* pg_sleep(1) */ set_config() */ 1',
    "SELECT $tag$pg_read_file('/etc/passwd')$tag$, $$pg_sleep(1)$$",
    'SELECT E\'pg_sleep(1)\\\'still_literal\'',
    'SELECT "pg_""sleep"(1)',
  ])('ignores denied names inside comments or string literals in %s', (sql) => {
    expect(hasStewardReadDeniedIdentifier(sql, denied)).toBe(false)
  })
})
