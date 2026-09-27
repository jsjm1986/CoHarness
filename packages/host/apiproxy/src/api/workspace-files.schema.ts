/** Wire schemas for the read-only Workspace file RPCs. */

import { z } from 'zod'
import type { OfficeToPdfGeneration } from '@deepseek-ai/dsh-office-to-pdf/types'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  WorkspaceFileByteWindow,
  WorkspaceFileStat,
  WorkspaceFileTextPage,
} from './workspace-files.ts'
import { sessionIdSchema } from './sessions.schema.ts'

const path = z.string().min(1).max(4096)
const versioned = z.object({
  path,
  type: z.union([z.literal('file'), z.literal('directory')]),
  bytes: z.number().int().nonnegative().optional(),
  version: z.string().min(1),
})

/** Wire validation for `workspaceFilesListRequestSchema`. */
export const workspaceFilesListRequestSchema = z.object({
  sessionId: sessionIdSchema,
  path: z.string().optional(),
  maxEntries: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspaceFiles.list'>>>

/** Wire validation for `workspaceFilesListValueSchema`. */
export const workspaceFilesListValueSchema = z.object({
  path,
  entries: z.array(versioned.extend({ name: z.string().min(1) })),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspaceFiles.list'>>>

/** Wire validation for `workspaceFilesStatRequestSchema`. */
export const workspaceFilesStatRequestSchema = z.object({
  sessionId: sessionIdSchema,
  path,
}) satisfies z.ZodType<Wire<RequestPayload<'workspaceFiles.stat'>>>

/** Wire validation for `workspaceFilesStatValueSchema`. */
export const workspaceFilesStatValueSchema = versioned satisfies z.ZodType<Wire<WorkspaceFileStat>>

/** Wire validation for `workspaceFilesReadRequestSchema`. */
export const workspaceFilesReadRequestSchema = z.object({
  sessionId: sessionIdSchema,
  path,
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  version: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspaceFiles.read'>>>

/** Wire validation for `workspaceFilesReadValueSchema`. */
export const workspaceFilesReadValueSchema = z.object({
  path,
  offset: z.number().int().positive(),
  limit: z.number().int().positive(),
  text: z.string(),
  eof: z.boolean(),
  version: z.string().min(1),
}) satisfies z.ZodType<Wire<WorkspaceFileTextPage>>

/** Wire validation for `workspaceFilesReadBytesRequestSchema`. */
export const workspaceFilesReadBytesRequestSchema = z.object({
  sessionId: sessionIdSchema,
  path,
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().positive().optional(),
  version: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspaceFiles.readBytes'>>>

/** Wire validation for `workspaceFilesReadBytesValueSchema`. */
export const workspaceFilesReadBytesValueSchema = z.object({
  path,
  offset: z.number().int().nonnegative(),
  bytes: z.string(),
  eof: z.boolean(),
  version: z.string().min(1),
}) satisfies z.ZodType<Wire<WorkspaceFileByteWindow>>

/** Office conversion uses the same Session and relative-path rules as other previews. */
export const workspaceFilesRenderOfficeRequestSchema = z.object({
  sessionId: sessionIdSchema, path, version: z.string().min(1).optional(),
  priority: z.enum(['foreground', 'background']).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspaceFiles.renderOffice'>>>

/** Converter generation admitted after non-empty string validation. */
const officeGenerationSchema = z.string().min(1) as unknown as z.ZodType<OfficeToPdfGeneration>

/** Complete PDF with no Host path or engine diagnostics. */
export const workspaceFilesRenderOfficeValueSchema = z.object({
  path, version: z.string().min(1), bytes: z.string(),
  missingFonts: z.array(z.string()), generation: officeGenerationSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'workspaceFiles.renderOffice'>>>
