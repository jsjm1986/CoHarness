/** Account names shared by persisted user records, managed paths and supervisor rendering. */

/** Lowercase account and supervisor names with a letter prefix and at most 31 characters. */
export const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/
