/**
 * Tests for abuse detection store
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryAbuseStore, initAbuseStore, abuseStore } from './abuseStore.js'

describe('AbuseStore', () => {
  beforeEach(() => {
    initAbuseStore(new InMemoryAbuseStore())
  })

  afterEach(async () => {
    await abuseStore.clear()
  })

  describe('counters', () => {
    it('should increment counter', async () => {
      const count = await abuseStore.incrementCounter('test-key', 60000)
      expect(count).toBe(1)
    })

    it('should increment counter multiple times', async () => {
      await abuseStore.incrementCounter('test-key', 60000)
      const count = await abuseStore.incrementCounter('test-key', 60000)
      expect(count).toBe(2)
    })

    it('should reset counter after window expires', async () => {
      await abuseStore.incrementCounter('test-key', 100) // 100ms window
      await new Promise((resolve) => setTimeout(resolve, 150))
      const count = await abuseStore.incrementCounter('test-key', 100)
      expect(count).toBe(1)
    })

    it('should get counter value', async () => {
      await abuseStore.incrementCounter('test-key', 60000)
      const count = await abuseStore.getCounter('test-key')
      expect(count).toBe(1)
    })

    it('should return 0 for expired counter', async () => {
      await abuseStore.incrementCounter('test-key', 100)
      await new Promise((resolve) => setTimeout(resolve, 150))
      const count = await abuseStore.getCounter('test-key')
      expect(count).toBe(0)
    })
  })

  describe('blocks', () => {
    it('should set block', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      
      const block = await abuseStore.getBlock('127.0.0.1', 'ip')
      expect(block).not.toBeNull()
      expect(block?.target).toBe('127.0.0.1')
      expect(block?.targetType).toBe('ip')
      expect(block?.type).toBe('credential_stuffing')
    })

    it('should set block with reason and blockedBy', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('user-123', 'user', 'manual_block', expiresAt, 'Test reason', 'admin-456')
      
      const block = await abuseStore.getBlock('user-123', 'user')
      expect(block?.reason).toBe('Test reason')
      expect(block?.blockedBy).toBe('admin-456')
    })

    it('should remove block', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      await abuseStore.removeBlock('127.0.0.1', 'ip')
      
      const block = await abuseStore.getBlock('127.0.0.1', 'ip')
      expect(block).toBeNull()
    })

    it('should return null for expired block', async () => {
      const expiresAt = new Date(Date.now() + 100)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      await new Promise((resolve) => setTimeout(resolve, 150))
      
      const block = await abuseStore.getBlock('127.0.0.1', 'ip')
      expect(block).toBeNull()
    })

    it('should list blocks', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      await abuseStore.setBlock('user-123', 'user', 'deal_spam', expiresAt)
      
      const blocks = await abuseStore.listBlocks()
      expect(blocks).toHaveLength(2)
    })

    it('should filter blocks by targetType', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      await abuseStore.setBlock('user-123', 'user', 'deal_spam', expiresAt)
      
      const ipBlocks = await abuseStore.listBlocks({ targetType: 'ip' })
      expect(ipBlocks).toHaveLength(1)
      expect(ipBlocks[0].targetType).toBe('ip')
    })

    it('should filter blocks by type', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      await abuseStore.setBlock('192.168.1.1', 'ip', 'scraping', expiresAt)
      
      const credentialBlocks = await abuseStore.listBlocks({ type: 'credential_stuffing' })
      expect(credentialBlocks).toHaveLength(1)
      expect(credentialBlocks[0].type).toBe('credential_stuffing')
    })
  })

  describe('events', () => {
    it('should add event', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      const event = await abuseStore.addEvent({
        target: '127.0.0.1',
        type: 'credential_stuffing',
        expiresAt,
      })
      
      expect(event.id).toBeDefined()
      expect(event.target).toBe('127.0.0.1')
      expect(event.type).toBe('credential_stuffing')
      expect(event.timestamp).toBeInstanceOf(Date)
    })

    it('should list events', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.addEvent({ target: '127.0.0.1', type: 'credential_stuffing', expiresAt })
      await abuseStore.addEvent({ target: 'user-123', type: 'deal_spam', expiresAt })
      
      const events = await abuseStore.listEvents()
      expect(events).toHaveLength(2)
    })

    it('should filter events by type', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.addEvent({ target: '127.0.0.1', type: 'credential_stuffing', expiresAt })
      await abuseStore.addEvent({ target: '192.168.1.1', type: 'scraping', expiresAt })
      
      const credentialEvents = await abuseStore.listEvents({ type: 'credential_stuffing' })
      expect(credentialEvents).toHaveLength(1)
      expect(credentialEvents[0].type).toBe('credential_stuffing')
    })

    it('should filter events by target', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.addEvent({ target: '127.0.0.1', type: 'credential_stuffing', expiresAt })
      await abuseStore.addEvent({ target: '192.168.1.1', type: 'scraping', expiresAt })
      
      const targetEvents = await abuseStore.listEvents({ target: '127.0.0.1' })
      expect(targetEvents).toHaveLength(1)
      expect(targetEvents[0].target).toBe('127.0.0.1')
    })

    it('should not include expired events', async () => {
      const expiresAt = new Date(Date.now() + 100)
      await abuseStore.addEvent({ target: '127.0.0.1', type: 'credential_stuffing', expiresAt })
      await new Promise((resolve) => setTimeout(resolve, 150))
      
      const events = await abuseStore.listEvents()
      expect(events).toHaveLength(0)
    })
  })

  describe('clear', () => {
    it('should clear all data', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.incrementCounter('test-key', 60000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      await abuseStore.addEvent({ target: '127.0.0.1', type: 'credential_stuffing', expiresAt })
      
      await abuseStore.clear()
      
      const count = await abuseStore.getCounter('test-key')
      const block = await abuseStore.getBlock('127.0.0.1', 'ip')
      const events = await abuseStore.listEvents()
      
      expect(count).toBe(0)
      expect(block).toBeNull()
      expect(events).toHaveLength(0)
    })
  })
})
