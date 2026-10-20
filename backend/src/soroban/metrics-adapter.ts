/**
 * Metrics-tracking wrapper for Soroban adapters
 * 
 * Wraps any SorobanAdapter to automatically track RPC call metrics
 */

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
} from './adapter.js';
import { SorobanConfig } from './client.js';
import { RawReceiptEvent } from '../indexer/event-parser.js';
import { recordSorobanRpcCall } from '../utils/metrics.js';

export class MetricsSorobanAdapter implements SorobanAdapter {
  constructor(private readonly wrapped: SorobanAdapter) {}

  async getBalance(account: string): Promise<bigint> {
    return this.trackCall('getBalance', () => this.wrapped.getBalance(account));
  }

  async credit(account: string, amount: bigint): Promise<void> {
    return this.trackCall('credit', () => this.wrapped.credit(account, amount));
  }

  async debit(account: string, amount: bigint): Promise<void> {
    return this.trackCall('debit', () => this.wrapped.debit(account, amount));
  }

  async getStakedBalance(account: string): Promise<bigint> {
    return this.trackCall('getStakedBalance', () => this.wrapped.getStakedBalance(account));
  }

  async getClaimableRewards(account: string): Promise<bigint> {
    return this.trackCall('getClaimableRewards', () => this.wrapped.getClaimableRewards(account));
  }

  async recordReceipt(params: RecordReceiptParams): Promise<void> {
    return this.trackCall('recordReceipt', () => this.wrapped.recordReceipt(params));
  }

  getConfig(): SorobanConfig {
    return this.wrapped.getConfig();
  }

  async getReceiptEvents(fromLedger: number | null): Promise<RawReceiptEvent[]> {
    return this.trackCall('getReceiptEvents', () => this.wrapped.getReceiptEvents(fromLedger));
  }

  async getTimelockEvents(fromLedger: number | null): Promise<any[]> {
    return this.trackCall('getTimelockEvents', () => this.wrapped.getTimelockEvents(fromLedger));
  }

  async executeTimelock(
    txHash: string,
    target: string,
    functionName: string,
    args: any[],
    eta: number
  ): Promise<string> {
    return this.trackCall('executeTimelock', () =>
      this.wrapped.executeTimelock(txHash, target, functionName, args, eta)
    );
  }

  async cancelTimelock(txHash: string): Promise<string> {
    return this.trackCall('cancelTimelock', () => this.wrapped.cancelTimelock(txHash));
  }

  // Optional admin operations
  async pause?(contractId: string): Promise<string> {
    if (!this.wrapped.pause) {
      throw new Error('pause not implemented');
    }
    return this.trackCall('pause', () => this.wrapped.pause!(contractId));
  }

  async unpause?(contractId: string): Promise<string> {
    if (!this.wrapped.unpause) {
      throw new Error('unpause not implemented');
    }
    return this.trackCall('unpause', () => this.wrapped.unpause!(contractId));
  }

  async setOperator?(contractId: string, operatorAddress: string | null): Promise<string> {
    if (!this.wrapped.setOperator) {
      throw new Error('setOperator not implemented');
    }
    return this.trackCall('setOperator', () =>
      this.wrapped.setOperator!(contractId, operatorAddress)
    );
  }

  async init?(
    contractId: string,
    adminAddress: string,
    operatorAddress?: string
  ): Promise<string> {
    if (!this.wrapped.init) {
      throw new Error('init not implemented');
    }
    return this.trackCall('init', () =>
      this.wrapped.init!(contractId, adminAddress, operatorAddress)
    );
  }

  async updateTenantReputation?(tenantId: string, record: TenantReputationRecord): Promise<void> {
    if (!this.wrapped.updateTenantReputation) {
      throw new Error('updateTenantReputation not implemented');
    }
    return this.trackCall('updateTenantReputation', () =>
      this.wrapped.updateTenantReputation!(tenantId, record)
    );
  }

  async getTenantReputation?(tenantId: string): Promise<TenantReputationRecord | null> {
    if (!this.wrapped.getTenantReputation) {
      throw new Error('getTenantReputation not implemented');
    }
    return this.trackCall('getTenantReputation', () =>
      this.wrapped.getTenantReputation!(tenantId)
    );
  }

  async stakeBond(inspectorId: string, amount: bigint): Promise<void> {
    return this.trackCall('stakeBond', () => this.wrapped.stakeBond(inspectorId, amount))
  }

  async unstakeBond(inspectorId: string): Promise<void> {
    return this.trackCall('unstakeBond', () => this.wrapped.unstakeBond(inspectorId))
  }

  async isBonded(inspectorId: string): Promise<boolean> {
    return this.trackCall('isBonded', () => this.wrapped.isBonded(inspectorId))
  }

  async getBond(inspectorId: string): Promise<{ isBonded: boolean; amount: bigint }> {
    return this.trackCall('getBond', () => this.wrapped.getBond(inspectorId))
  }

  // ── stake_delegation (#1489) ───────────────────────────────────────────────
  // MetricsSorobanAdapter is the outermost wrapper the routes actually hold, so
  // optional methods have to be forwarded here or callers cannot see them.

  async getOraclePrice?(pair: string): Promise<OraclePriceReading> {
    if (!this.wrapped.getOraclePrice) {
      throw new Error('getOraclePrice not implemented');
    }
    return this.trackCall('getOraclePrice', () => this.wrapped.getOraclePrice!(pair));
  }

  async isOraclePriceStale?(pair: string): Promise<boolean> {
    if (!this.wrapped.isOraclePriceStale) {
      throw new Error('isOraclePriceStale not implemented');
    }
    return this.trackCall('isOraclePriceStale', () => this.wrapped.isOraclePriceStale!(pair));
  }

  async createRentPaymentReceipt?(
    dealId: string,
    amount: bigint,
    payer: string,
    recipient: string,
    timestamp: number,
  ): Promise<string> {
    if (!this.wrapped.createRentPaymentReceipt) {
      throw new Error('createRentPaymentReceipt not implemented');
    }
    return this.trackCall('createRentPaymentReceipt', () =>
      this.wrapped.createRentPaymentReceipt!(dealId, amount, payer, recipient, timestamp),
    );
  }

  // vesting_schedule (#1911)
  async createVestingSchedule?(params: CreateVestingScheduleParams): Promise<string> {
    if (!this.wrapped.createVestingSchedule) {
      throw new Error('createVestingSchedule not implemented');
    }
    return this.trackCall('createVestingSchedule', () => this.wrapped.createVestingSchedule!(params));
  }

  async revokeVesting?(beneficiary: string): Promise<string> {
    if (!this.wrapped.revokeVesting) {
      throw new Error('revokeVesting not implemented');
    }
    return this.trackCall('revokeVesting', () => this.wrapped.revokeVesting!(beneficiary));
  }

  async getVestingSchedule?(beneficiary: string): Promise<VestingScheduleRecord | null> {
    if (!this.wrapped.getVestingSchedule) {
      throw new Error('getVestingSchedule not implemented');
    }
    return this.trackCall('getVestingSchedule', () => this.wrapped.getVestingSchedule!(beneficiary));
  }

  async getClaimableVested?(beneficiary: string): Promise<bigint> {
    if (!this.wrapped.getClaimableVested) {
      throw new Error('getClaimableVested not implemented');
    }
    return this.trackCall('getClaimableVested', () => this.wrapped.getClaimableVested!(beneficiary));
  }

  async prepareVestingClaim?(beneficiary: string): Promise<string> {
    if (!this.wrapped.prepareVestingClaim) {
      throw new Error('prepareVestingClaim not implemented');
    }
    return this.trackCall('prepareVestingClaim', () => this.wrapped.prepareVestingClaim!(beneficiary));
  }

  async submitVestingClaim?(signedXdr: string, beneficiary: string): Promise<string> {
    if (!this.wrapped.submitVestingClaim) {
      throw new Error('submitVestingClaim not implemented');
    }
    return this.trackCall('submitVestingClaim', () => this.wrapped.submitVestingClaim!(signedXdr, beneficiary));
  }

  // epoch_rewards (#1965) and multisig_admin (#1972)
  multisigTargetFor?(contract: 'dealEscrow' | 'contractAccess'): string | undefined {
    return this.wrapped.multisigTargetFor?.(contract);
  }

  multisigEnabled?(): boolean {
    return this.wrapped.multisigEnabled?.() ?? false;
  }

  multisigContractId?(): string | undefined {
    return this.wrapped.multisigContractId?.();
  }

  async epochRewardsCurrentEpoch?(): Promise<number> {
    if (!this.wrapped.epochRewardsCurrentEpoch) {
      throw new Error('epochRewardsCurrentEpoch not implemented');
    }
    return this.trackCall('epochRewardsCurrentEpoch', () => this.wrapped.epochRewardsCurrentEpoch!());
  }

  async epochRewardsGetEpoch?(epochNumber: number): Promise<EpochRewardsEpoch | null> {
    if (!this.wrapped.epochRewardsGetEpoch) {
      throw new Error('epochRewardsGetEpoch not implemented');
    }
    return this.trackCall('epochRewardsGetEpoch', () => this.wrapped.epochRewardsGetEpoch!(epochNumber));
  }

  async epochRewardsTotalStaked?(): Promise<bigint> {
    if (!this.wrapped.epochRewardsTotalStaked) {
      throw new Error('epochRewardsTotalStaked not implemented');
    }
    return this.trackCall('epochRewardsTotalStaked', () => this.wrapped.epochRewardsTotalStaked!());
  }

  async epochRewardsGetClaimable?(user: string): Promise<bigint> {
    if (!this.wrapped.epochRewardsGetClaimable) {
      throw new Error('epochRewardsGetClaimable not implemented');
    }
    return this.trackCall('epochRewardsGetClaimable', () => this.wrapped.epochRewardsGetClaimable!(user));
  }

  async epochRewardsGetStake?(user: string): Promise<bigint | null> {
    if (!this.wrapped.epochRewardsGetStake) {
      throw new Error('epochRewardsGetStake not implemented');
    }
    return this.trackCall('epochRewardsGetStake', () => this.wrapped.epochRewardsGetStake!(user));
  }

  async epochRewardsFund?(amount: bigint): Promise<string> {
    if (!this.wrapped.epochRewardsFund) {
      throw new Error('epochRewardsFund not implemented');
    }
    return this.trackCall('epochRewardsFund', () => this.wrapped.epochRewardsFund!(amount));
  }

  async epochRewardsSeal?(targetEpoch: number, nextEpochDurationSecs: number): Promise<string> {
    if (!this.wrapped.epochRewardsSeal) {
      throw new Error('epochRewardsSeal not implemented');
    }
    return this.trackCall('epochRewardsSeal', () => this.wrapped.epochRewardsSeal!(targetEpoch, nextEpochDurationSecs));
  }

  async prepareEpochRewardsCall?(call: EpochRewardsCall, user: string, amount?: bigint): Promise<string> {
    if (!this.wrapped.prepareEpochRewardsCall) {
      throw new Error('prepareEpochRewardsCall not implemented');
    }
    return this.trackCall('prepareEpochRewardsCall', () => this.wrapped.prepareEpochRewardsCall!(call, user, amount));
  }

  async submitEpochRewardsCall?(signedXdr: string, call: EpochRewardsCall, user: string, amount?: bigint): Promise<string> {
    if (!this.wrapped.submitEpochRewardsCall) {
      throw new Error('submitEpochRewardsCall not implemented');
    }
    return this.trackCall('submitEpochRewardsCall', () => this.wrapped.submitEpochRewardsCall!(signedXdr, call, user, amount));
  }

  async multisigGetConfig?(): Promise<MultisigConfig> {
    if (!this.wrapped.multisigGetConfig) {
      throw new Error('multisigGetConfig not implemented');
    }
    return this.trackCall('multisigGetConfig', () => this.wrapped.multisigGetConfig!());
  }

  async multisigListProposals?(status?: MultisigProposalStatus): Promise<MultisigProposal[]> {
    if (!this.wrapped.multisigListProposals) {
      throw new Error('multisigListProposals not implemented');
    }
    return this.trackCall('multisigListProposals', () => this.wrapped.multisigListProposals!(status));
  }

  async multisigGetProposal?(proposalId: number): Promise<MultisigProposal | null> {
    if (!this.wrapped.multisigGetProposal) {
      throw new Error('multisigGetProposal not implemented');
    }
    return this.trackCall('multisigGetProposal', () => this.wrapped.multisigGetProposal!(proposalId));
  }

  async multisigPropose?(target: string, functionName: string, args: MultisigArg[]): Promise<{ txHash: string; proposalId?: number }> {
    if (!this.wrapped.multisigPropose) {
      throw new Error('multisigPropose not implemented');
    }
    return this.trackCall('multisigPropose', () => this.wrapped.multisigPropose!(target, functionName, args));
  }

  async prepareMultisigCall?(call: MultisigCall, params: MultisigCallParams): Promise<string> {
    if (!this.wrapped.prepareMultisigCall) {
      throw new Error('prepareMultisigCall not implemented');
    }
    return this.trackCall('prepareMultisigCall', () => this.wrapped.prepareMultisigCall!(call, params));
  }

  async submitMultisigCall?(signedXdr: string, call: MultisigCall, params: MultisigCallParams): Promise<string> {
    if (!this.wrapped.submitMultisigCall) {
      throw new Error('submitMultisigCall not implemented');
    }
    return this.trackCall('submitMultisigCall', () => this.wrapped.submitMultisigCall!(signedXdr, call, params));
  }

  // stake_delegation (#1885)
  async prepareDelegationCall?(call: string, user: string, amount?: bigint, delegatee?: string): Promise<string> {
    if (!this.wrapped.prepareDelegationCall) {
      throw new Error('prepareDelegationCall not implemented');
    }
    return this.trackCall('prepareDelegationCall', () => this.wrapped.prepareDelegationCall!(call, user, amount, delegatee));
  }

  async submitDelegationCall?(signedXdr: string, call: string, user: string, amount?: bigint, delegatee?: string): Promise<string> {
    if (!this.wrapped.submitDelegationCall) {
      throw new Error('submitDelegationCall not implemented');
    }
    return this.trackCall('submitDelegationCall', () => this.wrapped.submitDelegationCall!(signedXdr, call, user, amount, delegatee));
  }

  async getDelegations?(user: string): Promise<Array<{ delegatee: string; amount: bigint; cooldownEndTs: number }>> {
    if (!this.wrapped.getDelegations) {
      throw new Error('getDelegations not implemented');
    }
    return this.trackCall('getDelegations', () => this.wrapped.getDelegations!(user));
  }

  async delegationStakedBalance?(user: string): Promise<bigint> {
    if (!this.wrapped.delegationStakedBalance) {
      throw new Error('delegationStakedBalance not implemented');
    }
    return this.trackCall('delegationStakedBalance', () => this.wrapped.delegationStakedBalance!(user));
  }

  async listDelegatees?(): Promise<Array<{ address: string; totalDelegated: bigint; commissionBps: number }>> {
    if (!this.wrapped.listDelegatees) {
      throw new Error('listDelegatees not implemented');
    }
    return this.trackCall('listDelegatees', () => this.wrapped.listDelegatees!());
  }

  async delegationCurrentEpoch?(): Promise<number> {
    if (!this.wrapped.delegationCurrentEpoch) {
      throw new Error('delegationCurrentEpoch not implemented');
    }
    return this.trackCall('delegationCurrentEpoch', () => this.wrapped.delegationCurrentEpoch!());
  }

  async setCommission?(operator: string, commissionBps: number): Promise<string> {
    if (!this.wrapped.setCommission) {
      throw new Error('setCommission not implemented');
    }
    return this.trackCall('setCommission', () => this.wrapped.setCommission!(operator, commissionBps));
  }

  async claimCommission?(operator: string): Promise<string> {
    if (!this.wrapped.claimCommission) {
      throw new Error('claimCommission not implemented');
    }
    return this.trackCall('claimCommission', () => this.wrapped.claimCommission!(operator));
  }

  async claimDelegateeRewards?(user: string): Promise<string> {
    if (!this.wrapped.claimDelegateeRewards) {
      throw new Error('claimDelegateeRewards not implemented');
    }
    return this.trackCall('claimDelegateeRewards', () => this.wrapped.claimDelegateeRewards!(user));
  }

  async prepareSetCommission?(operator: string, commissionBps: number): Promise<string> {
    if (!this.wrapped.prepareSetCommission) {
      throw new Error('prepareSetCommission not implemented');
    }
    return this.trackCall('prepareSetCommission', () => this.wrapped.prepareSetCommission!(operator, commissionBps));
  }

  async submitSetCommission?(signedXdr: string, operator: string, commissionBps: number): Promise<string> {
    if (!this.wrapped.submitSetCommission) {
      throw new Error('submitSetCommission not implemented');
    }
    return this.trackCall('submitSetCommission', () => this.wrapped.submitSetCommission!(signedXdr, operator, commissionBps));
  }

  async prepareClaimCommission?(operator: string): Promise<string> {
    if (!this.wrapped.prepareClaimCommission) {
      throw new Error('prepareClaimCommission not implemented');
    }
    return this.trackCall('prepareClaimCommission', () => this.wrapped.prepareClaimCommission!(operator));
  }

  async submitClaimCommission?(signedXdr: string, operator: string): Promise<string> {
    if (!this.wrapped.submitClaimCommission) {
      throw new Error('submitClaimCommission not implemented');
    }
    return this.trackCall('submitClaimCommission', () => this.wrapped.submitClaimCommission!(signedXdr, operator));
  }

  async prepareClaimDelegateeRewards?(user: string): Promise<string> {
    if (!this.wrapped.prepareClaimDelegateeRewards) {
      throw new Error('prepareClaimDelegateeRewards not implemented');
    }
    return this.trackCall('prepareClaimDelegateeRewards', () => this.wrapped.prepareClaimDelegateeRewards!(user));
  }

  async submitClaimDelegateeRewards?(signedXdr: string, user: string): Promise<string> {
    if (!this.wrapped.submitClaimDelegateeRewards) {
      throw new Error('submitClaimDelegateeRewards not implemented');
    }
    return this.trackCall('submitClaimDelegateeRewards', () => this.wrapped.submitClaimDelegateeRewards!(signedXdr, user));
  }

  /**
   * Helper method to track RPC calls with metrics
   */
  private async trackCall<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    let success = true;
    let errorType: string | undefined;

    try {
      const result = await fn();
      return result;
    } catch (error) {
      success = false;
      errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
      throw error;
    } finally {
      const durationMs = Date.now() - start;
      recordSorobanRpcCall(method, durationMs, success, errorType);
    }
  }
}
