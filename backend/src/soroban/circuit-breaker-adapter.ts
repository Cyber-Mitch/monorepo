import { logger } from '../utils/logger.js'
import {
  CircuitBreakerOpenError,
  logCircuitBreakerError,
  ErrorContext,
  classifyError,
} from './circuit-breaker-errors.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { CircuitBreakerConfig } from './circuit-breaker-config.js'
import {
  SorobanAdapter,
  RecordReceiptParams,
  TenantReputationRecord,
  OraclePriceReading,
  CreateVestingScheduleParams,
  VestingScheduleRecord,
  EpochRewardsCall,
  EpochRewardsEpoch,
  MultisigArg,
  MultisigCall,
  MultisigCallParams,
  MultisigConfig,
  MultisigProposal,
  MultisigProposalStatus,
} from './adapter.js'
import { SorobanConfig } from './client.js'
import { RawReceiptEvent } from '../indexer/event-parser.js'

/**
 * CircuitBreakerAdapter wraps a SorobanAdapter with circuit breaker protection.
 *
 * This adapter implements the SorobanAdapter interface and wraps an existing
 * adapter (typically RealSorobanAdapter) with circuit breaker state management.
 * It checks the circuit breaker state before delegating calls and throws
 * CircuitBreakerOpenError when the circuit is open.
 *
 * Thread-safe: Uses mutex protection for state transitions and concurrent calls.
 */
export class CircuitBreakerAdapter implements SorobanAdapter {
  private circuitBreaker: CircuitBreaker

  constructor(
    private wrappedAdapter: SorobanAdapter,
    config: CircuitBreakerConfig,
  ) {
    this.circuitBreaker = new CircuitBreaker(config)
  }

  /**
   * Get health status and metrics
   */
  getHealthStatus() {
    return this.circuitBreaker.getMetrics()
  }

  /**
   * Reset circuit breaker state (for testing)
   */
  async resetState(): Promise<void> {
    await this.circuitBreaker.resetState()
  }

  /**
   * Execute a wrapped adapter call with circuit breaker protection
   */
  private async executeWithCircuitBreaker<T>(
    methodName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Check state and potentially transition to Half-Open
    await this.circuitBreaker.checkState()

    // Check if call should be allowed
    const shouldAllow = await this.circuitBreaker.shouldAllowCall()
    if (!shouldAllow) {
      const metrics = this.circuitBreaker.getMetrics()
      throw new CircuitBreakerOpenError(
        metrics,
        methodName,
        'Circuit breaker is OPEN',
      )
    }

    // Execute the wrapped call
    try {
      const result = await fn()
      await this.circuitBreaker.recordSuccess()
      return result
    } catch (error) {
      const wasIncremented = await this.circuitBreaker.recordFailure(error)

      // Log the error with context
      const classification = classifyError(error)
      const context: ErrorContext = {
        methodName,
        error: error instanceof Error ? error : new Error(String(error)),
        classification,
        consecutiveFailures: this.circuitBreaker.getMetrics().consecutiveFailures,
        state: this.circuitBreaker.getMetrics().state,
        metrics: this.circuitBreaker.getMetrics(),
      }
      logCircuitBreakerError(context)

      // Re-throw the original error
      throw error
    }
  }

  /**
   * Get account balance
   */
  async getBalance(account: string): Promise<bigint> {
    return this.executeWithCircuitBreaker('getBalance', () =>
      this.wrappedAdapter.getBalance(account),
    )
  }

  /**
   * Credit an account
   */
  async credit(account: string, amount: bigint): Promise<void> {
    return this.executeWithCircuitBreaker('credit', () =>
      this.wrappedAdapter.credit(account, amount),
    )
  }

  /**
   * Debit an account
   */
  async debit(account: string, amount: bigint): Promise<void> {
    return this.executeWithCircuitBreaker('debit', () =>
      this.wrappedAdapter.debit(account, amount),
    )
  }

  /**
   * Get staked balance
   */
  async getStakedBalance(account: string): Promise<bigint> {
    return this.executeWithCircuitBreaker('getStakedBalance', () =>
      this.wrappedAdapter.getStakedBalance(account),
    )
  }

  /**
   * Get claimable rewards
   */
  async getClaimableRewards(account: string): Promise<bigint> {
    return this.executeWithCircuitBreaker('getClaimableRewards', () =>
      this.wrappedAdapter.getClaimableRewards(account),
    )
  }

  /**
   * Record a receipt
   */
  async recordReceipt(params: RecordReceiptParams): Promise<void> {
    return this.executeWithCircuitBreaker('recordReceipt', () =>
      this.wrappedAdapter.recordReceipt(params),
    )
  }

  /**
   * Get configuration
   */
  getConfig(): SorobanConfig {
    return this.wrappedAdapter.getConfig()
  }

  /**
   * Get receipt events
   */
  async getReceiptEvents(fromLedger: number | null): Promise<RawReceiptEvent[]> {
    return this.executeWithCircuitBreaker('getReceiptEvents', () =>
      this.wrappedAdapter.getReceiptEvents(fromLedger),
    )
  }

  /**
   * Get timelock events
   */
  async getTimelockEvents(fromLedger: number | null): Promise<any[]> {
    return this.executeWithCircuitBreaker('getTimelockEvents', () =>
      this.wrappedAdapter.getTimelockEvents(fromLedger),
    )
  }

  /**
   * Execute timelock transaction (admin operation)
   */
  async executeTimelock(txHash: string, target: string, functionName: string, args: any[], eta: number): Promise<string> {
    return this.executeWithCircuitBreaker('executeTimelock', () =>
      this.wrappedAdapter.executeTimelock(txHash, target, functionName, args, eta),
    )
  }

  /**
   * Cancel timelock transaction (admin operation)
   */
  async cancelTimelock(txHash: string): Promise<string> {
    return this.executeWithCircuitBreaker('cancelTimelock', () =>
      this.wrappedAdapter.cancelTimelock(txHash),
    )
  }

  /**
   * Pause contract (admin operation)
   */
  async pause?(contractId: string): Promise<string> {
    if (!this.wrappedAdapter.pause) {
      throw new Error('pause method not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('pause', () =>
      this.wrappedAdapter.pause!(contractId),
    )
  }

  /**
   * Unpause contract (admin operation)
   */
  async unpause?(contractId: string): Promise<string> {
    if (!this.wrappedAdapter.unpause) {
      throw new Error('unpause method not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('unpause', () =>
      this.wrappedAdapter.unpause!(contractId),
    )
  }

  async stakeBond(inspectorId: string, amount: bigint): Promise<void> {
    return this.executeWithCircuitBreaker('stakeBond', () =>
      this.wrappedAdapter.stakeBond(inspectorId, amount),
    )
  }

  async unstakeBond(inspectorId: string): Promise<void> {
    return this.executeWithCircuitBreaker('unstakeBond', () =>
      this.wrappedAdapter.unstakeBond(inspectorId),
    )
  }

  async isBonded(inspectorId: string): Promise<boolean> {
    return this.executeWithCircuitBreaker('isBonded', () =>
      this.wrappedAdapter.isBonded(inspectorId),
    )
  }

  async getBond(inspectorId: string): Promise<{ isBonded: boolean; amount: bigint }> {
    return this.executeWithCircuitBreaker('getBond', () =>
      this.wrappedAdapter.getBond(inspectorId),
    )
  }

  /**
   * Set operator (admin operation)
   */
  async setOperator?(contractId: string, operatorAddress: string | null): Promise<string> {
    if (!this.wrappedAdapter.setOperator) {
      throw new Error('setOperator method not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('setOperator', () =>
      this.wrappedAdapter.setOperator!(contractId, operatorAddress),
    )
  }

  /**
   * Initialize contract (admin operation)
   */
  async init?(contractId: string, adminAddress: string, operatorAddress?: string): Promise<string> {
    if (!this.wrappedAdapter.init) {
      throw new Error('init method not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('init', () =>
      this.wrappedAdapter.init!(contractId, adminAddress, operatorAddress),
    )
  }

  async updateTenantReputation?(tenantId: string, record: TenantReputationRecord): Promise<void> {
    if (!this.wrappedAdapter.updateTenantReputation) {
      throw new Error('updateTenantReputation not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('updateTenantReputation', () =>
      this.wrappedAdapter.updateTenantReputation!(tenantId, record),
    )
  }

  async getTenantReputation?(tenantId: string): Promise<TenantReputationRecord | null> {
    if (!this.wrappedAdapter.getTenantReputation) {
      throw new Error('getTenantReputation not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('getTenantReputation', () =>
      this.wrappedAdapter.getTenantReputation!(tenantId),
    )
  }

  // ── stake_delegation (#1489) ───────────────────────────────────────────────
  // Forwarded explicitly so the delegation routes see the methods through the
  // circuit-breaker wrapper; without these the wrapper hides them and the
  // routes report the feature as unavailable.

  async getOraclePrice?(pair: string): Promise<OraclePriceReading> {
    if (!this.wrappedAdapter.getOraclePrice) {
      throw new Error('getOraclePrice not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('getOraclePrice', () =>
      this.wrappedAdapter.getOraclePrice!(pair),
    )
  }

  async isOraclePriceStale?(pair: string): Promise<boolean> {
    if (!this.wrappedAdapter.isOraclePriceStale) {
      throw new Error('isOraclePriceStale not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('isOraclePriceStale', () =>
      this.wrappedAdapter.isOraclePriceStale!(pair),
    )
  }

  async createRentPaymentReceipt?(
    dealId: string,
    amount: bigint,
    payer: string,
    recipient: string,
    timestamp: number,
  ): Promise<string> {
    if (!this.wrappedAdapter.createRentPaymentReceipt) {
      throw new Error('createRentPaymentReceipt not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('createRentPaymentReceipt', () =>
      this.wrappedAdapter.createRentPaymentReceipt!(dealId, amount, payer, recipient, timestamp),
    )
  }

  // ── vesting_schedule (#1911) ───────────────────────────────────────────────

  async createVestingSchedule?(params: CreateVestingScheduleParams): Promise<string> {
    if (!this.wrappedAdapter.createVestingSchedule) {
      throw new Error('createVestingSchedule not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('createVestingSchedule', () =>
      this.wrappedAdapter.createVestingSchedule!(params),
    )
  }

  async revokeVesting?(beneficiary: string): Promise<string> {
    if (!this.wrappedAdapter.revokeVesting) {
      throw new Error('revokeVesting not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('revokeVesting', () =>
      this.wrappedAdapter.revokeVesting!(beneficiary),
    )
  }

  async getVestingSchedule?(beneficiary: string): Promise<VestingScheduleRecord | null> {
    if (!this.wrappedAdapter.getVestingSchedule) {
      throw new Error('getVestingSchedule not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('getVestingSchedule', () =>
      this.wrappedAdapter.getVestingSchedule!(beneficiary),
    )
  }

  async getClaimableVested?(beneficiary: string): Promise<bigint> {
    if (!this.wrappedAdapter.getClaimableVested) {
      throw new Error('getClaimableVested not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('getClaimableVested', () =>
      this.wrappedAdapter.getClaimableVested!(beneficiary),
    )
  }

  async prepareVestingClaim?(beneficiary: string): Promise<string> {
    if (!this.wrappedAdapter.prepareVestingClaim) {
      throw new Error('prepareVestingClaim not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('prepareVestingClaim', () =>
      this.wrappedAdapter.prepareVestingClaim!(beneficiary),
    )
  }

  async submitVestingClaim?(signedXdr: string, beneficiary: string): Promise<string> {
    if (!this.wrappedAdapter.submitVestingClaim) {
      throw new Error('submitVestingClaim not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('submitVestingClaim', () =>
      this.wrappedAdapter.submitVestingClaim!(signedXdr, beneficiary),
    )
  }
  // ── epoch_rewards (#1965) and multisig_admin (#1972) ───────────────────────

  multisigEnabled?(): boolean {
    return this.wrappedAdapter.multisigEnabled?.() ?? false
  }

  multisigContractId?(): string | undefined {
    return this.wrappedAdapter.multisigContractId?.()
  }

  async epochRewardsCurrentEpoch?(): Promise<number> {
    if (!this.wrappedAdapter.epochRewardsCurrentEpoch) {
      throw new Error('epochRewardsCurrentEpoch not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('epochRewardsCurrentEpoch', () =>
      this.wrappedAdapter.epochRewardsCurrentEpoch!(),
    )
  }

  async epochRewardsGetEpoch?(epochNumber: number): Promise<EpochRewardsEpoch | null> {
    if (!this.wrappedAdapter.epochRewardsGetEpoch) {
      throw new Error('epochRewardsGetEpoch not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('epochRewardsGetEpoch', () =>
      this.wrappedAdapter.epochRewardsGetEpoch!(epochNumber),
    )
  }

  async epochRewardsTotalStaked?(): Promise<bigint> {
    if (!this.wrappedAdapter.epochRewardsTotalStaked) {
      throw new Error('epochRewardsTotalStaked not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('epochRewardsTotalStaked', () =>
      this.wrappedAdapter.epochRewardsTotalStaked!(),
    )
  }

  async epochRewardsGetClaimable?(user: string): Promise<bigint> {
    if (!this.wrappedAdapter.epochRewardsGetClaimable) {
      throw new Error('epochRewardsGetClaimable not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('epochRewardsGetClaimable', () =>
      this.wrappedAdapter.epochRewardsGetClaimable!(user),
    )
  }

  async epochRewardsGetStake?(user: string): Promise<bigint | null> {
    if (!this.wrappedAdapter.epochRewardsGetStake) {
      throw new Error('epochRewardsGetStake not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('epochRewardsGetStake', () =>
      this.wrappedAdapter.epochRewardsGetStake!(user),
    )
  }

  async epochRewardsFund?(amount: bigint): Promise<string> {
    if (!this.wrappedAdapter.epochRewardsFund) {
      throw new Error('epochRewardsFund not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('epochRewardsFund', () =>
      this.wrappedAdapter.epochRewardsFund!(amount),
    )
  }

  async epochRewardsSeal?(targetEpoch: number, nextEpochDurationSecs: number): Promise<string> {
    if (!this.wrappedAdapter.epochRewardsSeal) {
      throw new Error('epochRewardsSeal not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('epochRewardsSeal', () =>
      this.wrappedAdapter.epochRewardsSeal!(targetEpoch, nextEpochDurationSecs),
    )
  }

  async prepareEpochRewardsCall?(call: EpochRewardsCall, user: string, amount?: bigint): Promise<string> {
    if (!this.wrappedAdapter.prepareEpochRewardsCall) {
      throw new Error('prepareEpochRewardsCall not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('prepareEpochRewardsCall', () =>
      this.wrappedAdapter.prepareEpochRewardsCall!(call, user, amount),
    )
  }

  async submitEpochRewardsCall?(signedXdr: string, call: EpochRewardsCall, user: string, amount?: bigint): Promise<string> {
    if (!this.wrappedAdapter.submitEpochRewardsCall) {
      throw new Error('submitEpochRewardsCall not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('submitEpochRewardsCall', () =>
      this.wrappedAdapter.submitEpochRewardsCall!(signedXdr, call, user, amount),
    )
  }

  async multisigGetConfig?(): Promise<MultisigConfig> {
    if (!this.wrappedAdapter.multisigGetConfig) {
      throw new Error('multisigGetConfig not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('multisigGetConfig', () =>
      this.wrappedAdapter.multisigGetConfig!(),
    )
  }

  async multisigListProposals?(status?: MultisigProposalStatus): Promise<MultisigProposal[]> {
    if (!this.wrappedAdapter.multisigListProposals) {
      throw new Error('multisigListProposals not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('multisigListProposals', () =>
      this.wrappedAdapter.multisigListProposals!(status),
    )
  }

  async multisigGetProposal?(proposalId: number): Promise<MultisigProposal | null> {
    if (!this.wrappedAdapter.multisigGetProposal) {
      throw new Error('multisigGetProposal not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('multisigGetProposal', () =>
      this.wrappedAdapter.multisigGetProposal!(proposalId),
    )
  }

  async multisigPropose?(target: string, functionName: string, args: MultisigArg[]): Promise<{ txHash: string; proposalId?: number }> {
    if (!this.wrappedAdapter.multisigPropose) {
      throw new Error('multisigPropose not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('multisigPropose', () =>
      this.wrappedAdapter.multisigPropose!(target, functionName, args),
    )
  }

  async prepareMultisigCall?(call: MultisigCall, params: MultisigCallParams): Promise<string> {
    if (!this.wrappedAdapter.prepareMultisigCall) {
      throw new Error('prepareMultisigCall not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('prepareMultisigCall', () =>
      this.wrappedAdapter.prepareMultisigCall!(call, params),
    )
  }

  async submitMultisigCall?(signedXdr: string, call: MultisigCall, params: MultisigCallParams): Promise<string> {
    if (!this.wrappedAdapter.submitMultisigCall) {
      throw new Error('submitMultisigCall not supported by wrapped adapter')
    }
    return this.executeWithCircuitBreaker('submitMultisigCall', () =>
      this.wrappedAdapter.submitMultisigCall!(signedXdr, call, params),
    )
  }
}
