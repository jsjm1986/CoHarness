/** Browser HTTP client for the optional Host user-document service. */
import type { UserDocIdType, UserDocLimits, UserDocRef } from '@deepseek-ai/dsh-userdoc'
import { createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError } from '@deepseek-ai/dsh-client-ui-conversation/src/client/userdoc-client.ts'

export type { UserDocIdType, UserDocLimits, UserDocRef }

export { createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError }
