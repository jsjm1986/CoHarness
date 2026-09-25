// Ambient module faces for workspace modules whose sources do not compile
// under this project's strict flags: vendored Cordis builds under its own
// relaxed tsconfig, and the Typert protocol package keeps a likewise distinct
// checking face. The `paths` map in tsconfig.json covers the workspace sources
// that do compile; only the merge targets needed by their module augmentations
// are declared here. tsconfig.build.json excludes this file, so production
// builds resolve the real packages through node_modules links and their
// emitted declarations.
import type {} from '@deepseek-ai/dsh-typert-protocol'

export {}

declare module '@deepseek-ai/cordis' {
  export interface Events {}
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface RemoteErrorDetailsMap {}
}
