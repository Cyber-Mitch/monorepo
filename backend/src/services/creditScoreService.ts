import {
  bandFromScore,
  creditScoreSnapshotStore,
  type CreditScoreFactor,
  type CreditScoreSnapshot,
} from '../models/creditScoreSnapshot.js'
import type { UnderwritingResult } from './underwritingRuleEngine.js'

export class CreditScoreService {
  async recordUnderwritingSnapshot(userId: string, result: UnderwritingResult): Promise<CreditScoreSnapshot> {
    const score = result.maxScore > 0
      ? Math.max(0, Math.min(100, Math.round((result.totalScore / result.maxScore) * 100)))
      : 0

    const factors: CreditScoreFactor[] = result.triggeredRules.map((rule) => ({
      name: rule.ruleId,
      status: rule.passed ? 'pass' : rule.score > 0 ? 'warn' : 'fail',
      weight: rule.weight,
      detail: rule.reason,
    }))

    return creditScoreSnapshotStore.create({
      userId,
      score,
      band: bandFromScore(score),
      factors,
      computedAt: new Date(result.evaluatedAt),
    })
  }

  async getLatestSnapshot(tenantId: string): Promise<CreditScoreSnapshot | null> {
    return creditScoreSnapshotStore.getLatestByUserId(tenantId)
  }

  async getHistory(tenantId: string, limit = 12): Promise<CreditScoreSnapshot[]> {
    return creditScoreSnapshotStore.getHistoryByUserId(tenantId, limit)
  }

  generateImprovementTips(snapshot: CreditScoreSnapshot): string[] {
    return snapshot.factors
      .filter((factor) => factor.status === 'fail' || factor.status === 'warn')
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((factor) => this.tipForFactor(factor))
  }

  private tipForFactor(factor: CreditScoreFactor): string {
    const action = factor.status === 'fail' ? 'Improve' : 'Strengthen'
    return `${action} ${factor.name.replaceAll('_', ' ')}: ${factor.detail}`
  }
}

export const creditScoreService = new CreditScoreService()
