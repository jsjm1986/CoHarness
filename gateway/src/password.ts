import argon2 from 'argon2'

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 1024

/** Validate the password policy shared by every account mutation path. */
export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`)
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`password must be at most ${String(MAX_PASSWORD_LENGTH)} characters`)
  }
}

export function hashPassword(password: string): Promise<string> {
  validatePassword(password)
  return argon2.hash(password, OPTIONS)
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  // Avoid handing attacker-controlled megabyte strings to Argon2 during login;
  // the same policy that bounds password creation also bounds verification.
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return Promise.resolve(false)
  }
  return argon2.verify(hash, password).catch(() => false)
}
