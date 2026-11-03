/** Host admission retains the writer until the complete document operation settles. */
import type { UserDocBackgroundWrite } from './upload.ts'

/**
 * Admit one provider write while preserving its result and failure.
 * @param admit - host maintenance and write-epoch check; absent permits standalone storage.
 * @param operation - complete write, including durable cleanup.
 * @returns the operation result after the host releases its writer.
 */
export async function admitDocumentWrite<T>(admit: UserDocBackgroundWrite | undefined, operation: () => Promise<T>): Promise<T> {
  if (admit === undefined) return operation()
  let result!: T
  await admit(async () => { result = await operation() })
  return result
}
