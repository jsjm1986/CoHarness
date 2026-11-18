/** In-memory credential references for template tests; record operations are unexpected. */

import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

/** Resolves references from {@link TestCredentials.values}; every other operation throws. */
export class TestCredentials extends CredentialProvider {
  values = new Map<string, string>()

  protected override resolveOwned(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'fixture' })
  }

  protected override describeOwned(): Promise<CredentialInfo> { throw new Error('unexpected credential description') }
  protected override setOwned(): Promise<void> { throw new Error('unexpected credential write') }
  protected override unsetOwned(): Promise<void> { throw new Error('unexpected credential removal') }
  override readRecord(): Promise<CredentialRecord | undefined> { throw new Error('unexpected record read') }
  override describeRecord(): Promise<CredentialRecordInfo> { throw new Error('unexpected record description') }
  override listRecords(): Promise<readonly CredentialRecordEntry[]> { throw new Error('unexpected record listing') }
  override modifyRecord(): Promise<CredentialRecord | undefined> { throw new Error('unexpected record write') }
  override deleteRecord(): Promise<void> { throw new Error('unexpected record removal') }
}
