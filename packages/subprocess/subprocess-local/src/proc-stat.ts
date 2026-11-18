/** Node-only Linux process identity and non-zombie process-group observation. */

import { readFileSync, readdirSync } from 'node:fs'

interface ProcStat {
  pid: number
  parentPid: number
  pgrp: number
  session: number
  state: string
  ttyDevice: number
  tpgid: number
  started: string
}

/**
 * Parse fields used from Linux `/proc/<pid>/stat`, including parenthesized comm text.
 * @param text - complete stat line.
 * @returns Parsed identity/group fields, or undefined for malformed input.
 */
export function parseProcStat(text: string): ProcStat | undefined {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close <= open) return undefined
  const pid = Number(text.slice(0, open).trim())
  const rest = text.slice(close + 2).trim().split(/\s+/)
  const state = rest[0] || ''
  const parentPid = Number(rest[1])
  const pgrp = Number(rest[2])
  const session = Number(rest[3])
  const ttyDevice = Number(rest[4])
  const tpgid = Number(rest[5])
  const started = rest[19]
  if (![pid, parentPid, pgrp, session, ttyDevice, tpgid].every(Number.isSafeInteger)
    || state.length !== 1 || started === undefined) return undefined
  return { pid, parentPid, pgrp, session, state, ttyDevice, tpgid, started }
}

interface ProcOperations {
  readDir(path: string): string[]
  readFile(path: string): string
}

/* v8 ignore start -- thin filesystem bindings; injected process-table decisions are unit-tested. */
const DEFAULT_OPERATIONS: ProcOperations = {
  readDir: path => readdirSync(path),
  readFile: path => readFileSync(path, 'utf8'),
}
/* v8 ignore stop */

/**
 * Find an executing member of a Linux process group. `false` means the group
 * contains only zombie/dead entries; `undefined` means the process table could
 * not prove either outcome. A still-executing `knownMember` is returned from
 * its own stat entry without enumerating `/proc`, so repeated polls of a
 * long-lived group cost one file read instead of one per host process. A failed
 * or malformed row makes a zombie-only observation incomplete; an observed live
 * member still establishes occupancy.
 * @param processGroupId - POSIX process-group id to inspect.
 * @param knownMember - member PID returned by an earlier call, if any.
 * @param internals - injectable process-table operations.
 * @returns An executing member's PID; `false` when every group entry is
 * zombie/dead; `undefined` when `/proc` is unreadable or lists no provable
 * group entry.
 */
export function linuxProcessGroupLiveMember(
  processGroupId: number,
  knownMember: number | undefined,
  internals: ProcOperations = DEFAULT_OPERATIONS,
): number | false | undefined {
  if (knownMember !== undefined) {
    let known: ProcStat | undefined
    try {
      known = parseProcStat(internals.readFile(`/proc/${knownMember}/stat`))
    } catch (_unreadableProcEntry) {
      known = undefined
    }
    if (known?.pgrp === processGroupId && !/^[ZXx]$/.test(known.state)) return knownMember
  }
  let entries: string[]
  try {
    entries = internals.readDir('/proc')
  } catch (_unreadableProcDirectory) {
    return undefined
  }
  let matched = false
  let complete = true
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat: ProcStat | undefined
    try {
      stat = parseProcStat(internals.readFile(`/proc/${Number(entry)}/stat`))
    } catch (_unreadableProcEntry) {
      complete = false
      continue
    }
    if (stat === undefined) { complete = false; continue }
    if (stat.pgrp !== processGroupId) continue
    matched = true
    if (!/^[ZXx]$/.test(stat.state)) return stat.pid
  }
  return matched && complete ? false : undefined
}
