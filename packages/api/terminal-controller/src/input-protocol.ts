/** Wire protocol constants and frames for the low-latency terminal input WebSocket. */

/** Exact Host upgrade path carrying coalesced terminal input and resize frames. */
export const TERMINAL_INPUT_PATH = '/api/terminal/input'

/** Client-to-Host terminal input request frame. */
export type TerminalInputClientFrame =
  | { readonly type: 'write'; readonly seq: number; readonly data: string }
  | { readonly type: 'resize'; readonly seq: number; readonly cols: number; readonly rows: number }

/** Host-to-Client terminal input acknowledgement or typed error frame. */
export type TerminalInputServerFrame =
  | { readonly type: 'ack'; readonly seq: number }
  | {
    readonly type: 'error'
    readonly seq: number
    readonly code?: string
    readonly message: string
    readonly details?: Record<string, unknown>
  }
