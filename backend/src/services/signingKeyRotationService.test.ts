import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { getSigningKeyRotationService, resetSigningKeyRotationService } from './signingKeyRotationService.js'
import { setPool, type PgPoolLike } from '../db.js'
import {
  getSigningKeyMaterialStore,
  InMemorySigningKeyMaterialStore,
  initSigningKeyMaterialStore,
} from '../models/signingKeyMaterialStore.js'

describe('SigningKeyRotationService - Unit Tests', () => {
  let mockPool: PgPoolLike
  let rotationService: ReturnType<typeof getSigningKeyRotationService>

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(),
    } as any

    // Set required environment variables for tests
    process.env.SOROBAN_RPC_URL = 'https://test-rpc.example.com'
    process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test Network'

    setPool(mockPool)
    initSigningKeyMaterialStore(new InMemorySigningKeyMaterialStore())
    resetSigningKeyRotationService()
    rotationService = getSigningKeyRotationService()
  })

  afterEach(() => {
    resetSigningKeyRotationService()
    setPool(null)
    delete process.env.SOROBAN_RPC_URL
    delete process.env.SOROBAN_NETWORK_PASSPHRASE
  })

  describe('Service initialization', () => {
    it('should throw error if SOROBAN_RPC_URL is not set', () => {
      delete process.env.SOROBAN_RPC_URL
      resetSigningKeyRotationService()

      expect(() => getSigningKeyRotationService()).toThrow(
        'SOROBAN_RPC_URL environment variable is required'
      )
    })

    it('should initialize successfully with required env vars', () => {
      expect(rotationService).toBeDefined()
    })
  })

  describe('getActiveKey', () => {
    it('should return null when no active rotation exists', async () => {
      mockPool.query = vi.fn().mockResolvedValueOnce({ rows: [] })

      const activeKey = await rotationService.getActiveKey('admin' as any, 'GTEST')

      expect(activeKey).toBeNull()
    })

    it('should return active_key_id when rotation exists', async () => {
      const mockRotation = {
        id: 'rotation-1',
        state: 'active_pointer_cutover',
        key_type: 'admin',
        account_address: 'GTEST',
        active_key_id: 'new-key-123',
        audit_log: [],
      }

      mockPool.query = vi.fn().mockResolvedValueOnce({ rows: [mockRotation] })

      const activeKey = await rotationService.getActiveKey('admin' as any, 'GTEST')

      expect(activeKey).toBe('new-key-123')
    })
  })

  describe('getRotation', () => {
    it('should return null for non-existent rotation', async () => {
      mockPool.query = vi.fn().mockResolvedValueOnce({ rows: [] })

      const rotation = await rotationService.getRotation('non-existent')

      expect(rotation).toBeNull()
    })

    it('should return rotation data for existing rotation', async () => {
      const mockRotation = {
        id: 'rotation-1',
        state: 'new_key_provisioned',
        key_type: 'admin',
        account_address: 'GTEST',
        old_key_id: 'old-key',
        new_key_id: 'new-key',
        active_key_id: 'old-key',
        audit_log: [],
        initiated_at: new Date(),
      }

      mockPool.query = vi.fn().mockResolvedValueOnce({ rows: [mockRotation] })

      const rotation = await rotationService.getRotation('rotation-1')

      expect(rotation).toBeDefined()
      expect(rotation?.id).toBe('rotation-1')
      expect(rotation?.state).toBe('new_key_provisioned')
    })
  })

  describe('retrieveKeyMaterial', () => {
    it('should throw error when retrieving non-existent key', async () => {
      await expect(
        rotationService.retrieveKeyMaterial('non-existent', 'admin' as any)
      ).rejects.toThrow('Key material not found')
    })

    it('should retrieve stored key material', async () => {
      const keyId = 'test-key-1'
      const secret = 'S' + 'A'.repeat(55)

      // Store key material directly in the in-memory store
      await getSigningKeyMaterialStore().put(keyId, 'admin', secret)

      const retrieved = await rotationService.retrieveKeyMaterial(keyId, 'admin' as any)

      expect(retrieved).toBe(secret)
    })
  })

  describe('key material across restarts (#1941)', () => {
    it('signs with a rotated key after the service restarts', async () => {
      const signer = Keypair.random()
      const keyId = 'key_rotated'

      // Rotation stores the new key through storeKeyMaterial.
      await (rotationService as any).storeKeyMaterial(keyId, signer.secret(), 'admin')

      // Simulate a restart. The service instance is dropped, but the key material
      // store (Postgres in production) still holds the key.
      resetSigningKeyRotationService()
      const restarted = getSigningKeyRotationService()

      const secret = await restarted.retrieveKeyMaterial(keyId, 'admin')
      const payload = Buffer.from('signed after restart')
      const signature = Keypair.fromSecret(secret).sign(payload)

      expect(signer.verify(payload, signature)).toBe(true)
    })

    it('stops returning a key once it has been destroyed', async () => {
      const keyId = 'key_retired'
      await (rotationService as any).storeKeyMaterial(keyId, Keypair.random().secret(), 'admin')

      await (rotationService as any).destroyKeyMaterial(keyId, 'admin')

      await expect(rotationService.retrieveKeyMaterial(keyId, 'admin')).rejects.toThrow(
        'Key material not found',
      )
    })
  })

  describe('Audit logging', () => {
    it('should add audit entries correctly', () => {
      const auditLog: any[] = []
      const updated = (rotationService as any).addAuditEntry(auditLog, 'test_event', { key: 'value' })

      expect(updated.length).toBe(1)
      expect(updated[0].event).toBe('test_event')
      expect(updated[0].details).toEqual({ key: 'value' })
      expect(updated[0].timestamp).toBeDefined()
    })

    it('should preserve existing audit entries', () => {
      const auditLog = [
        { timestamp: '2024-01-01', event: 'event1', details: {} },
      ]
      const updated = (rotationService as any).addAuditEntry(auditLog, 'event2', {})

      expect(updated.length).toBe(2)
      expect(updated[0].event).toBe('event1')
      expect(updated[1].event).toBe('event2')
    })
  })
})
