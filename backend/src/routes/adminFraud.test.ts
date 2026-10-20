import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { createAdminFraudRouter } from './adminFraud.js'
import { getFraudStore } from '../fraud/store.js'
import { getFraudEngine } from '../fraud/engine.js'
import { SignalType, RiskLevel, EntityType, ActionType } from '../fraud/types.js'
import { adminAuthHeader, seedAdminSession } from '../test-fixtures/adminAuth.js'

vi.mock('../fraud/store.js', () => ({
  getFraudStore: vi.fn(),
  InMemoryFraudStore: vi.fn().mockImplementation(() => ({
    createSignal: vi.fn(),
    getSignal: vi.fn(),
    listSignals: vi.fn(),
    updateSignal: vi.fn(),
    deleteSignal: vi.fn(),
    enableSignal: vi.fn(),
    disableSignal: vi.fn(),
    createAssessment: vi.fn(),
    getAssessment: vi.fn(),
    getAssessmentsByEntity: vi.fn(),
    listAssessments: vi.fn(),
    createAccountHold: vi.fn(),
    getActiveHolds: vi.fn(),
    releaseHold: vi.fn(),
  })),
}))

vi.mock('../fraud/engine.js', () => ({
  getFraudEngine: vi.fn(),
  FraudDetectionEngine: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn(),
    updateThresholds: vi.fn(),
    getThresholds: vi.fn(),
  })),
}))

vi.mock('../schemas/env.js', () => ({
  env: {
    MANUAL_ADMIN_SECRET: 'test-secret',
  },
}))

vi.mock('../db.js', () => ({
  getPool: vi.fn(async () => null),
  setPool: vi.fn(),
  getPoolMetrics: vi.fn(() => null),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    req.requestId = 'test-request-id'
    next()
  })
  app.use('/api/admin/fraud', createAdminFraudRouter())
  app.use(errorHandler)
  return app
}

describe('Admin Fraud Routes', () => {
  beforeEach(async () => {
    await seedAdminSession()
    vi.clearAllMocks()
  })

  describe('Signal Management', () => {
    describe('GET /api/admin/fraud/signals', () => {
      it('should list all signals with valid admin secret', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          listSignals: vi.fn().mockResolvedValue([
            {
              id: 'signal-1',
              name: 'Test Signal',
              signalType: SignalType.THRESHOLD,
              enabled: true,
            },
          ]),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/signals')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.signals).toBeInstanceOf(Array)
        expect(res.body.signals.length).toBeGreaterThan(0)
        expect(res.body.signals[0]).toMatchObject({
          name: 'Test Signal',
          signalType: SignalType.THRESHOLD,
          enabled: true,
        })
      })

      it('should filter signals by enabled status', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          listSignals: vi.fn().mockResolvedValue([
            { id: '1', name: 'Enabled Signal', signalType: SignalType.THRESHOLD, enabled: true },
          ]),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/signals?enabled=true')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.signals.every((s: any) => s.enabled === true)).toBe(true)
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).get('/api/admin/fraud/signals')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })

      it('should reject request with an invalid token', async () => {
        const res = await request(buildApp())
          .get('/api/admin/fraud/signals')
          .set('Authorization', 'Bearer not-a-real-token')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('INVALID_TOKEN')
      })
    })

    describe('GET /api/admin/fraud/signals/:id', () => {
      it('should get a single signal by id', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          getSignal: vi.fn().mockResolvedValue({
            id: 'signal-1',
            name: 'Test Signal',
            signalType: SignalType.RULE,
          }),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/signals/signal-1')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.signal.id).toBe('signal-1')
        expect(res.body.signal.name).toBe('Test Signal')
      })

      it('should return 404 for non-existent signal', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          getSignal: vi.fn().mockResolvedValue(null),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/signals/non-existent-id')
          .set(adminAuthHeader)

        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe('NOT_FOUND')
        expect(res.body.error.message).toContain('not found')
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).get('/api/admin/fraud/signals/some-id')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('POST /api/admin/fraud/signals', () => {
      it('should create a new signal', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          createSignal: vi.fn().mockResolvedValue({
            id: 'signal-1',
            name: 'New Fraud Signal',
            signalType: SignalType.PATTERN,
          }),
        } as any)

        const newSignal = {
          name: 'New Fraud Signal',
          description: 'Test description',
          signalType: SignalType.PATTERN,
          config: { pattern: '^\\d+$' },
          enabled: true,
          scoreWeight: 25,
        }

        const res = await request(buildApp())
          .post('/api/admin/fraud/signals')
          .set(adminAuthHeader)
          .send(newSignal)

        expect(res.status).toBe(201)
        expect(res.body.signal.name).toBe('New Fraud Signal')
        expect(res.body.signal.signalType).toBe(SignalType.PATTERN)
        expect(res.body.signal.id).toBeDefined()
      })

      it('should validate required fields', async () => {
        const res = await request(buildApp())
          .post('/api/admin/fraud/signals')
          .set(adminAuthHeader)
          .send({ name: '' }) // Invalid: empty name

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('VALIDATION_ERROR')
      })

      it('should validate scoreWeight range', async () => {
        const res = await request(buildApp())
          .post('/api/admin/fraud/signals')
          .set(adminAuthHeader)
          .send({
            name: 'Test',
            signalType: SignalType.THRESHOLD,
            config: {},
            scoreWeight: 150, // Invalid: > 100
          })

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('VALIDATION_ERROR')
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp())
          .post('/api/admin/fraud/signals')
          .send({ name: 'Test', signalType: SignalType.THRESHOLD, config: {} })

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('PUT /api/admin/fraud/signals/:id', () => {
      it('should update an existing signal', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          updateSignal: vi.fn().mockResolvedValue({
            id: 'signal-1',
            name: 'Updated Name',
          }),
        } as any)

        const res = await request(buildApp())
          .put('/api/admin/fraud/signals/signal-1')
          .set(adminAuthHeader)
          .send({ name: 'Updated Name' })

        expect(res.status).toBe(200)
        expect(res.body.signal.name).toBe('Updated Name')
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp())
          .put('/api/admin/fraud/signals/some-id')
          .send({ name: 'Updated' })

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('DELETE /api/admin/fraud/signals/:id', () => {
      it('should delete a signal', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          deleteSignal: vi.fn().mockResolvedValue(undefined),
        } as any)

        const res = await request(buildApp())
          .delete('/api/admin/fraud/signals/signal-1')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).delete('/api/admin/fraud/signals/some-id')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('POST /api/admin/fraud/signals/:id/enable', () => {
      it('should enable a signal', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          enableSignal: vi.fn().mockResolvedValue(undefined),
        } as any)

        const res = await request(buildApp())
          .post('/api/admin/fraud/signals/signal-1/enable')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).post('/api/admin/fraud/signals/some-id/enable')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('POST /api/admin/fraud/signals/:id/disable', () => {
      it('should disable a signal', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          disableSignal: vi.fn().mockResolvedValue(undefined),
        } as any)

        const res = await request(buildApp())
          .post('/api/admin/fraud/signals/signal-1/disable')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).post('/api/admin/fraud/signals/some-id/disable')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })
  })

  describe('Assessment Management', () => {
    describe('POST /api/admin/fraud/evaluate', () => {
      it('should evaluate an event against fraud signals', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          createAssessment: vi.fn().mockResolvedValue({
            id: 'assessment-1',
            entityId: 'account-123',
            riskLevel: RiskLevel.LOW,
          }),
        } as any)
        vi.mocked(getFraudEngine).mockReturnValue({
          evaluate: vi.fn().mockResolvedValue({
            id: 'assessment-1',
            entityId: 'account-123',
            riskLevel: RiskLevel.LOW,
          }),
        } as any)

        const evaluationRequest = {
          entityType: EntityType.ACCOUNT,
          entityId: 'account-123',
          eventData: { amount: 5000 },
          metadata: { source: 'manual' },
        }

        const res = await request(buildApp())
          .post('/api/admin/fraud/evaluate')
          .set(adminAuthHeader)
          .send(evaluationRequest)

        expect(res.status).toBe(200)
        expect(res.body.assessment).toBeDefined()
        expect(res.body.assessment.entityId).toBe('account-123')
        expect(res.body.assessment.riskLevel).toBeDefined()
      })

      it('should validate required fields', async () => {
        const res = await request(buildApp())
          .post('/api/admin/fraud/evaluate')
          .set(adminAuthHeader)
          .send({ entityType: EntityType.ACCOUNT }) // Missing entityId

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('VALIDATION_ERROR')
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp())
          .post('/api/admin/fraud/evaluate')
          .send({
            entityType: EntityType.ACCOUNT,
            entityId: 'account-123',
            eventData: {},
          })

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('GET /api/admin/fraud/assessments', () => {
      it('should list assessments with filters', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          listAssessments: vi.fn().mockResolvedValue([
            {
              id: 'assessment-1',
              entityId: 'account-123',
              riskLevel: RiskLevel.HIGH,
            },
          ]),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/assessments?riskLevel=high&limit=10')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.assessments).toBeInstanceOf(Array)
      })

      it('should validate limit parameter', async () => {
        const res = await request(buildApp())
          .get('/api/admin/fraud/assessments?limit=300')
          .set(adminAuthHeader)

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('VALIDATION_ERROR')
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).get('/api/admin/fraud/assessments')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('GET /api/admin/fraud/assessments/:id', () => {
      it('should get a single assessment', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          getAssessment: vi.fn().mockResolvedValue({
            id: 'assessment-1',
            entityId: 'payment-123',
            riskLevel: RiskLevel.MEDIUM,
          }),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/assessments/assessment-1')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.assessment.id).toBe('assessment-1')
      })

      it('should return 404 for non-existent assessment', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          getAssessment: vi.fn().mockResolvedValue(null),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/assessments/non-existent')
          .set(adminAuthHeader)

        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe('NOT_FOUND')
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).get('/api/admin/fraud/assessments/some-id')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('GET /api/admin/fraud/assessments/entity/:type/:id', () => {
      it('should get assessments for a specific entity', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          getAssessmentsByEntity: vi.fn().mockResolvedValue([
            {
              id: 'assessment-1',
              entityId: 'account-456',
              riskLevel: RiskLevel.MEDIUM,
            },
          ]),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/assessments/entity/account/account-456')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.assessments).toBeInstanceOf(Array)
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp())
          .get('/api/admin/fraud/assessments/entity/account/some-id')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })
  })

  describe('Account Hold Management', () => {
    describe('GET /api/admin/fraud/holds/:accountId', () => {
      it('should get active holds for an account', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          getActiveHolds: vi.fn().mockResolvedValue([
            {
              id: 'hold-1',
              accountId: 'account-789',
              holdType: 'full',
            },
          ]),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/holds/account-789')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.holds).toBeInstanceOf(Array)
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).get('/api/admin/fraud/holds/some-account')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('POST /api/admin/fraud/holds/:holdId/release', () => {
      it('should release an account hold', async () => {
        vi.mocked(getFraudStore).mockReturnValue({
          releaseHold: vi.fn().mockResolvedValue(undefined),
        } as any)

        const res = await request(buildApp())
          .post('/api/admin/fraud/holds/hold-1/release')
          .set(adminAuthHeader)
          .send({ releasedBy: 'admin-123' })

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
      })

      it('should validate releasedBy field', async () => {
        const res = await request(buildApp())
          .post('/api/admin/fraud/holds/some-hold-id/release')
          .set(adminAuthHeader)
          .send({}) // Missing releasedBy

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('VALIDATION_ERROR')
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp())
          .post('/api/admin/fraud/holds/some-hold-id/release')
          .send({ releasedBy: 'admin-123' })

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })
  })

  describe('Threshold Management', () => {
    describe('GET /api/admin/fraud/thresholds', () => {
      it('should get current risk thresholds', async () => {
        vi.mocked(getFraudEngine).mockReturnValue({
          getThresholds: vi.fn().mockReturnValue({
            medium: 30,
            high: 60,
            critical: 90,
          }),
        } as any)

        const res = await request(buildApp())
          .get('/api/admin/fraud/thresholds')
          .set(adminAuthHeader)

        expect(res.status).toBe(200)
        expect(res.body.thresholds).toBeDefined()
        expect(res.body.thresholds.medium).toBeDefined()
        expect(res.body.thresholds.high).toBeDefined()
        expect(res.body.thresholds.critical).toBeDefined()
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp()).get('/api/admin/fraud/thresholds')

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })

    describe('PUT /api/admin/fraud/thresholds', () => {
      it('should update risk thresholds', async () => {
        vi.mocked(getFraudEngine).mockReturnValue({
          updateThresholds: vi.fn(),
          getThresholds: vi.fn().mockReturnValue({
            medium: 35,
            high: 65,
            critical: 95,
          }),
        } as any)

        const newThresholds = {
          medium: 35,
          high: 65,
          critical: 95,
        }

        const res = await request(buildApp())
          .put('/api/admin/fraud/thresholds')
          .set(adminAuthHeader)
          .send(newThresholds)

        expect(res.status).toBe(200)
        expect(res.body.thresholds.medium).toBe(35)
        expect(res.body.thresholds.high).toBe(65)
        expect(res.body.thresholds.critical).toBe(95)
      })

      it('should validate threshold values are non-negative', async () => {
        const res = await request(buildApp())
          .put('/api/admin/fraud/thresholds')
          .set(adminAuthHeader)
          .send({ medium: -10 }) // Invalid: negative value

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('VALIDATION_ERROR')
      })

      it('should reject request without authentication', async () => {
        const res = await request(buildApp())
          .put('/api/admin/fraud/thresholds')
          .send({ medium: 30 })

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe('UNAUTHORIZED')
      })
    })
  })
})
