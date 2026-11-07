// Gateway checking uses emitted workspace declarations. These merge targets
// keep protocol augmentation visible; standalone production emission excludes this file.
import type {} from '@deepseek-ai/dsh-typert-protocol'

export {}

declare module '@deepseek-ai/cordis' {
  export interface Events {}
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface RemoteErrorDetailsMap {}
}
