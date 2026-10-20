import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setPool, type PgPoolLike } from '../db.js'
import type { EncryptionService } from '../services/walletService.js'
import { PostgresSigningKeyMaterialStore } from './signingKeyMaterialStore.js'

/**
 * Reversible stand-in for the real envelope encryption. The test only needs to see
 * that the ciphertext is not the plaintext and that the key version is recorded.
 */
function fakeEncryption(): EncryptionService {
  return {
    getCurrentKeyId: () => 'v2',
    encrypt: async (data: Buffer, keyId: string) => ({
      cipherText: Buffer.from(`${keyId}:${data.toString('base64')}`, 'utf8'),
      keyId,
    }),
    decrypt: async (cipherText: Buffer, keyId: string) => {
      const [prefix, encoded] = cipherText.toString('utf8').split(':')
      if (prefix !== keyId) {
        throw new Error('wrong key version')
      }
      return Buffer.from(encoded, 'base64')
    },
  }
}

describe('PostgresSigningKeyMaterialStore (#1941)', () => {
  const SECRET = 'S' + 'B'.repeat(55)
  let mockPool: { query: ReturnType<typeof vi.fn> }
  let store: PostgresSigningKeyMaterialStore

  beforeEach(() => {
    mockPool = { query: vi.fn() }
    setPool(mockPool as unknown as PgPoolLike)
    store = new PostgresSigningKeyMaterialStore(fakeEncryption())
  })

  afterEach(() => {
    setPool(null)
  })

  it('never sends the plaintext secret to the database', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] })

    await store.put('key_1', 'admin', SECRET)

    const [sql, params] = mockPool.query.mock.calls[0]
    expect(sql).toContain('INSERT INTO signing_key_material')
    expect(JSON.stringify(params)).not.toContain(SECRET)
    expect(params).toEqual(['key_1', 'admin', expect.any(String), 'v2'])
  })

  it('reads back the secret it stored', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] })
    await store.put('key_1', 'admin', SECRET)
    const [keyId, , ciphertext, keyVersion] = mockPool.query.mock.calls[0][1]

    mockPool.query.mockResolvedValueOnce({ rows: [{ ciphertext, key_version: keyVersion }] })

    await expect(store.get(keyId, 'admin')).resolves.toBe(SECRET)
  })

  it('returns null for an unknown key id', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] })

    await expect(store.get('missing', 'admin')).resolves.toBeNull()
  })

  it('zeroes the ciphertext on destroy and keeps the row as a tombstone', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] })

    await store.destroy('key_1', 'admin')

    const [sql, params] = mockPool.query.mock.calls[0]
    expect(sql).toMatch(/SET ciphertext = '', retired_at = NOW\(\)/)
    expect(params).toEqual(['admin', 'key_1'])
  })
})
