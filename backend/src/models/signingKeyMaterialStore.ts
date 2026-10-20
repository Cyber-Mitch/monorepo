/**
 * Signing Key Material Store (#1941)
 *
 * Holds the secret for each rotated signing key so that a restart or a second
 * instance can still sign with the active key. The rotation service writes the
 * secret once, reads it on every signing call, and destroys it when the key is
 * retired.
 *
 * Implementations:
 * - InMemorySigningKeyMaterialStore: default, and for tests. Nothing survives a restart.
 * - PostgresSigningKeyMaterialStore: encrypts with the same EncryptionService
 *   that seals custodial wallet keys. The database never sees a plaintext secret.
 *
 * A KMS or HSM-backed store can be added later by implementing KeyMaterialStore
 * and passing it to initSigningKeyMaterialStore(). Put only key ids, never secrets, into logs.
 */

import { getPool } from '../db.js'
import type { EncryptionService } from '../services/walletService.js'
import type { KeyType } from '../services/signingKeyRotationService.js'

export interface KeyMaterialStore {
  /** Persist the secret for a key id. Rejects if the key id already exists. */
  put(keyId: string, keyType: KeyType, secret: string): Promise<void>
  /** Return the secret for a key id, or null if it is unknown or was destroyed. */
  get(keyId: string, keyType: KeyType): Promise<string | null>
  /** Zero the stored secret. After this, get() returns null for the key id. */
  destroy(keyId: string, keyType: KeyType): Promise<void>
}

/**
 * In-memory implementation for tests and for environments without a database.
 */
export class InMemorySigningKeyMaterialStore implements KeyMaterialStore {
  private readonly secrets = new Map<string, string>()

  private storageKey(keyId: string, keyType: KeyType): string {
    return `${keyType}:${keyId}`
  }

  async put(keyId: string, keyType: KeyType, secret: string): Promise<void> {
    this.secrets.set(this.storageKey(keyId, keyType), secret)
  }

  async get(keyId: string, keyType: KeyType): Promise<string | null> {
    return this.secrets.get(this.storageKey(keyId, keyType)) ?? null
  }

  async destroy(keyId: string, keyType: KeyType): Promise<void> {
    this.secrets.delete(this.storageKey(keyId, keyType))
  }
}

/**
 * PostgreSQL implementation. Secrets are sealed with the EncryptionService before
 * they reach the database, and the key version is stored so decryption still works
 * after the encryption key rotates.
 */
export class PostgresSigningKeyMaterialStore implements KeyMaterialStore {
  constructor(private readonly encryptionService: EncryptionService) {}

  async put(keyId: string, keyType: KeyType, secret: string): Promise<void> {
    const pool = await getPool()
    if (!pool) {
      throw new Error('Database pool is not available')
    }

    const keyVersion = this.encryptionService.getCurrentKeyId()
    const { cipherText } = await this.encryptionService.encrypt(Buffer.from(secret, 'utf8'), keyVersion)

    await pool.query(
      `INSERT INTO signing_key_material (key_id, key_type, ciphertext, key_version)
       VALUES ($1, $2, $3, $4)`,
      [keyId, keyType, cipherText.toString('base64'), keyVersion],
    )
  }

  async get(keyId: string, keyType: KeyType): Promise<string | null> {
    const pool = await getPool()
    if (!pool) {
      throw new Error('Database pool is not available')
    }

    const { rows } = await pool.query(
      `SELECT ciphertext, key_version
       FROM signing_key_material
       WHERE key_type = $1 AND key_id = $2 AND retired_at IS NULL`,
      [keyType, keyId],
    )
    if (rows.length === 0) {
      return null
    }

    const plainText = await this.encryptionService.decrypt(
      Buffer.from(rows[0].ciphertext, 'base64'),
      rows[0].key_version,
    )
    return plainText.toString('utf8')
  }

  async destroy(keyId: string, keyType: KeyType): Promise<void> {
    const pool = await getPool()
    if (!pool) {
      throw new Error('Database pool is not available')
    }

    // Overwrite the ciphertext and keep the row as a tombstone for the audit trail.
    await pool.query(
      `UPDATE signing_key_material
       SET ciphertext = '', retired_at = NOW()
       WHERE key_type = $1 AND key_id = $2`,
      [keyType, keyId],
    )
  }
}

// Singleton instance. Defaults to in-memory. app.ts swaps in the Postgres store when DATABASE_URL is set.
let signingKeyMaterialStore: KeyMaterialStore = new InMemorySigningKeyMaterialStore()

export function initSigningKeyMaterialStore(store: KeyMaterialStore): void {
  signingKeyMaterialStore = store
}

export function getSigningKeyMaterialStore(): KeyMaterialStore {
  return signingKeyMaterialStore
}
