/**
 * Tests for admin abuse routes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createAdminAbuseRouter } from './adminAbuse.js'
import { initAbuseStore, InMemoryAbuseStore, abuseStore } from '../models/abuseStore.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'

// Mock middleware
vi.mock('../middleware/auth.js')
vi.mock('../middleware/rbac.js')

describe('Admin Abuse Routes', () => {
  let app: express.Application

  beforeEach(() => {
    initAbuseStore(new InMemoryAbuseStore())
    
    app = express()
    app.use(express.json())
    
    // Mock authentication - return the middleware function
    ;(authenticateToken as any).mockImplementation(() => (req, res, next) => {
      ;(req as any).user = { id: 'admin-123', role: 'admin' }
      next()
    })
    
    // Mock authorization - return the middleware function
    ;(requirePermission as any).mockImplementation(() => (req, res, next) => next())
    
    app.use('/api/v1/admin/abuse', createAdminAbuseRouter())
  })

  afterEach(async () => {
    await abuseStore.clear()
  })

  describe('GET /events', () => {
    it('should list abuse events', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.addEvent({ target: '127.0.0.1', type: 'credential_stuffing', expiresAt })
      
      const response = await request(app).get('/api/v1/admin/abuse/events')
      
      expect(response.status).toBe(200)
      expect(response.body.events).toHaveLength(1)
      expect(response.body.events[0].target).toBe('127.0.0.1')
    })

    it('should filter events by type', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.addEvent({ target: '127.0.0.1', type: 'credential_stuffing', expiresAt })
      await abuseStore.addEvent({ target: '192.168.1.1', type: 'scraping', expiresAt })
      
      const response = await request(app).get('/api/v1/admin/abuse/events?type=credential_stuffing')
      
      expect(response.status).toBe(200)
      expect(response.body.events).toHaveLength(1)
      expect(response.body.events[0].type).toBe('credential_stuffing')
    })

    it('should filter events by target', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.addEvent({ target: '127.0.0.1', type: 'credential_stuffing', expiresAt })
      await abuseStore.addEvent({ target: '192.168.1.1', type: 'scraping', expiresAt })
      
      const response = await request(app).get('/api/v1/admin/abuse/events?target=127.0.0.1')
      
      expect(response.status).toBe(200)
      expect(response.body.events).toHaveLength(1)
      expect(response.body.events[0].target).toBe('127.0.0.1')
    })
  })

  describe('GET /blocks', () => {
    it('should list active blocks', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      
      const response = await request(app).get('/api/v1/admin/abuse/blocks')
      
      expect(response.status).toBe(200)
      expect(response.body.blocks).toHaveLength(1)
      expect(response.body.blocks[0].target).toBe('127.0.0.1')
    })

    it('should filter blocks by targetType', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      await abuseStore.setBlock('user-123', 'user', 'deal_spam', expiresAt)
      
      const response = await request(app).get('/api/v1/admin/abuse/blocks?targetType=ip')
      
      expect(response.status).toBe(200)
      expect(response.body.blocks).toHaveLength(1)
      expect(response.body.blocks[0].targetType).toBe('ip')
    })

    it('should filter blocks by type', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      await abuseStore.setBlock('192.168.1.1', 'ip', 'scraping', expiresAt)
      
      const response = await request(app).get('/api/v1/admin/abuse/blocks?type=credential_stuffing')
      
      expect(response.status).toBe(200)
      expect(response.body.blocks).toHaveLength(1)
      expect(response.body.blocks[0].type).toBe('credential_stuffing')
    })
  })

  describe('POST /blocks', () => {
    it('should create manual block', async () => {
      const response = await request(app)
        .post('/api/v1/admin/abuse/blocks')
        .send({
          target: '127.0.0.1',
          targetType: 'ip',
          reason: 'Manual block for testing',
          expiryHours: 24,
        })
      
      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.target).toBe('127.0.0.1')
      
      const block = await abuseStore.getBlock('127.0.0.1', 'ip')
      expect(block).not.toBeNull()
      expect(block?.type).toBe('manual_block')
      expect(block?.reason).toBe('Manual block for testing')
    })

    it('should require targetType', async () => {
      const response = await request(app)
        .post('/api/v1/admin/abuse/blocks')
        .send({
          target: '127.0.0.1',
          reason: 'Manual block for testing',
          expiryHours: 24,
        })
      
      expect(response.status).toBe(400)
    })

    it('should require reason', async () => {
      const response = await request(app)
        .post('/api/v1/admin/abuse/blocks')
        .send({
          target: '127.0.0.1',
          targetType: 'ip',
          expiryHours: 24,
        })
      
      expect(response.status).toBe(400)
    })

    it('should validate expiryHours range', async () => {
      const response = await request(app)
        .post('/api/v1/admin/abuse/blocks')
        .send({
          target: '127.0.0.1',
          targetType: 'ip',
          reason: 'Manual block for testing',
          expiryHours: 10000, // Too large
        })
      
      expect(response.status).toBe(400)
    })
  })

  describe('DELETE /blocks/:target', () => {
    it('should remove block', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await abuseStore.setBlock('127.0.0.1', 'ip', 'credential_stuffing', expiresAt)
      
      const response = await request(app)
        .delete('/api/v1/admin/abuse/blocks/127.0.0.1?targetType=ip')
      
      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      
      const block = await abuseStore.getBlock('127.0.0.1', 'ip')
      expect(block).toBeNull()
    })

    it('should require targetType query parameter', async () => {
      const response = await request(app).delete('/api/v1/admin/abuse/blocks/127.0.0.1')
      
      expect(response.status).toBe(400)
    })

    it('should return 404 for non-existent block', async () => {
      const response = await request(app)
        .delete('/api/v1/admin/abuse/blocks/127.0.0.1?targetType=ip')
      
      expect(response.status).toBe(404)
    })
  })
})
