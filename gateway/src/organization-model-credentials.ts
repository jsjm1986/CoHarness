import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const KEY_BYTES = 32
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16

function assertOwnerOnly(path: string, mode: number): void {
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new Error(`organization model credential path must be owner-only: chmod ${path.endsWith('/') ? '700' : '600'} ${path}`)
  }
}

function readKey(path: string): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`organization model credential key must be a regular file: ${path}`)
  }
  assertOwnerOnly(path, stat.mode)
  const encoded = readFileSync(path, 'utf8').trim()
  const key = Buffer.from(encoded, 'base64url')
  if (key.length !== KEY_BYTES || key.toString('base64url') !== encoded) {
    throw new Error(`organization model credential key must contain one canonical 32-byte base64url value: ${path}`)
  }
  return key
}

/** Load or create the owner-only master key used for organization model credentials. */
export function loadOrganizationModelCredentialKey(path: string): Buffer {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  assertOwnerOnly(`${parent}/`, lstatSync(parent).mode)
  if (!existsSync(path)) {
    const encoded = randomBytes(KEY_BYTES).toString('base64url')
    try {
      writeFileSync(path, `${encoded}\n`, { flag: 'wx', mode: 0o600 })
      chmodSync(path, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  return readKey(path)
}

/** AES-GCM fields stored for one organization Provider credential. */
export interface EncryptedOrganizationModelCredential {
  keyVersion: 1
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

/** Encrypt and decrypt organization model credentials with provider-bound AAD. */
export class OrganizationModelCredentialCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error('organization model credential key must be 32 bytes')
  }

  private aad(organizationId: string, providerId: string): Buffer {
    return Buffer.from(`dsh-organization-model-credential\0${organizationId}\0${providerId}\0v1`, 'utf8')
  }

  /** Encrypt one non-empty credential value for its owning organization and Provider. */
  encrypt(organizationId: string, providerId: string, value: string): EncryptedOrganizationModelCredential {
    if (value.length === 0) throw new Error('organization model credential must not be empty')
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: AUTH_TAG_BYTES })
    cipher.setAAD(this.aad(organizationId, providerId))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return { keyVersion: 1, nonce, ciphertext, authTag: cipher.getAuthTag() }
  }

  /** Decrypt one stored credential after authenticating its owning organization and Provider. */
  decrypt(
    organizationId: string,
    providerId: string,
    encrypted: EncryptedOrganizationModelCredential,
  ): string {
    if (encrypted.keyVersion !== 1) {
      throw new Error(`unsupported organization model credential key version ${String(encrypted.keyVersion)}`)
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    })
    decipher.setAAD(this.aad(organizationId, providerId))
    decipher.setAuthTag(encrypted.authTag)
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8')
  }
}
