import {
     SorobanAdapter,
     RecordReceiptParams,
     SyncDealStatusParams,
     TenantReputationRecord,
     RequestRentReleaseParams,
     ChallengeRentReleaseParams,
     ResolveRentDisputeParams,
     SettleRentReleaseTimeoutParams,
     SettleDisputeTimeoutParams,
     RegisterRentToOwnDealParams,
     RecordRentToOwnEquityPaymentParams,
     RentToOwnDealActionParams,
     OraclePriceReading,
     OnChainReceipt,
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
import { logger } from '../utils/logger.js'
import { Account, Keypair, TransactionBuilder, nativeToScVal, Address, xdr } from '@stellar/stellar-sdk'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { assertVestingClaimXdr, buildVestingClaimOperation } from './vestingClaim.js'
import { vestedAmount } from './vestingMath.js'
import { assertSignedInvocation, buildInvokeOperation } from './userSignedTx.js'
import { encodeMultisigArg } from './multisigArgs.js'
import { StubEpochRewards } from './stub-epoch-rewards.js'
import { StubMultisig } from './stub-multisig.js'

export class StubSorobanAdapter implements SorobanAdapter {
     private static stubBalances = new Map<string, bigint>()
     private static stubBonds = new Map<string, bigint>()
     private static stubReputations = new Map<string, TenantReputationRecord>()
     private static stubVestings = new Map<string, VestingScheduleRecord>()
     private static stubEpochRewards = new StubEpochRewards()
     private static stubMultisig = new StubMultisig()
     private config: SorobanConfig

     constructor(config: SorobanConfig) {
          this.config = config
          logger.info('Soroban adapter: stub')
          logger.debug('Soroban stub config', { rpcUrl: config.rpcUrl })
          if (config.contractId) {
               logger.debug('Soroban stub config', { contractId: config.contractId })
          }
     }

     /**
      * Resets all stub state including balances for all instances.
      */
     public static _testOnlyReset(): void {
          this.stubBalances.clear()
          this.stubBonds.clear()
          this.stubReputations.clear()
          this.stubVestings.clear()
          this.stubEpochRewards = new StubEpochRewards()
          this.stubMultisig = new StubMultisig()
          logger.debug('Soroban stub: static reset complete (balances, bonds, reputations and vestings cleared)')
     }

     /**
      * Resets instance-specific state and global stub balances.
      */
     public _testOnlyReset(): void {
          this._ledger = 1000
          StubSorobanAdapter._testOnlyReset()
          logger.debug('Soroban stub: instance reset complete')
     }

     async getBalance(account: string): Promise<bigint> {
          if (!StubSorobanAdapter.stubBalances.has(account)) {
               const hash = this.simpleHash(account)
               const balance = BigInt(1000 + (hash % 9000))
               StubSorobanAdapter.stubBalances.set(account, balance)
          }
          const balance = StubSorobanAdapter.stubBalances.get(account)!
          logger.debug('Soroban stub: getBalance', { account, balance: balance.toString() })
          return balance
     }

     async credit(account: string, amount: bigint): Promise<void> {
          const currentBalance = await this.getBalance(account)
          const newBalance = currentBalance + amount
          StubSorobanAdapter.stubBalances.set(account, newBalance)
          logger.debug('Soroban stub: credit', {
               account,
               amount: amount.toString(),
               newBalance: newBalance.toString(),
          })
     }

     async debit(account: string, amount: bigint): Promise<void> {
          const currentBalance = await this.getBalance(account)
          if (currentBalance < amount) {
               throw new Error(`Insufficient balance: ${currentBalance.toString()} < ${amount.toString()}`)
          }
          const newBalance = currentBalance - amount
          StubSorobanAdapter.stubBalances.set(account, newBalance)
          logger.debug('Soroban stub: debit', {
               account,
               amount: amount.toString(),
               newBalance: newBalance.toString(),
          })
     }

     async getStakedBalance(account: string): Promise<bigint> {
          const hash = this.simpleHash(`staked:${this.config.contractId ?? 'stub'}:${account}`)
          const staked = BigInt(hash % 5_000) * 1_000_000n
          logger.debug('Soroban stub: getStakedBalance', { account, staked: staked.toString() })
          return staked
     }

     async getClaimableRewards(account: string): Promise<bigint> {
          const hash = this.simpleHash(`claimable:${this.config.contractId ?? 'stub'}:${account}`)
          const claimable = BigInt(hash % 250) * 1_000_000n
          logger.debug('Soroban stub: getClaimableRewards', { account, claimable: claimable.toString() })
          return claimable
     }

     async usedStake(account: string): Promise<bigint> {
          const staked = await this.getMvpStakedBalance(account)
          const hash = this.simpleHash(`used:${this.config.mvpStakingPoolId ?? 'stub'}:${account}`)
          return BigInt(hash % (Number(staked / 1_000_000n) + 1)) * 1_000_000n
     }

     async unusedStake(account: string): Promise<bigint> {
          const staked = await this.getMvpStakedBalance(account)
          const used = await this.usedStake(account)
          return staked - used
     }

     async claimable(account: string): Promise<bigint> {
          return this.getMvpClaimable(account)
     }

     async stake(account: string, amount: bigint): Promise<string> {
          logger.info('Soroban stub: mvp stake', { account, amount: amount.toString() })
          return 'stub_tx_hash_mvp_stake'
     }

     async unstake(account: string, amount: bigint): Promise<string> {
          logger.info('Soroban stub: mvp unstake', { account, amount: amount.toString() })
          return 'stub_tx_hash_mvp_unstake'
     }

     async utilizeStake(user: string, amount: bigint): Promise<string> {
          logger.info('Soroban stub: mvp utilizeStake', { user, amount: amount.toString() })
          return 'stub_tx_hash_mvp_utilize_stake'
     }

     async claim(account: string): Promise<string> {
          logger.info('Soroban stub: mvp claim', { account })
          return 'stub_tx_hash_mvp_claim'
     }

     private async getMvpStakedBalance(account: string): Promise<bigint> {
          const hash = this.simpleHash(`mvp-staked:${this.config.mvpStakingPoolId ?? 'stub'}:${account}`)
          return BigInt(hash % 5_000) * 1_000_000n
     }

     private async getMvpClaimable(account: string): Promise<bigint> {
          const hash = this.simpleHash(`mvp-claimable:${this.config.mvpStakingPoolId ?? 'stub'}:${account}`)
          return BigInt(hash % 250) * 1_000_000n
     }

     /**
      * Stub recordReceipt: logs the call but performs no on-chain work.
      *
      * The real on-chain `record_receipt` invocation lives in
      * `RealSorobanAdapter.recordReceipt` (real-adapter.ts), which is selected
      * when SOROBAN_ADAPTER_MODE=real (see `createSorobanAdapter` in index.ts).
      *
      * This stub is intentionally inert so local development and unit tests
      * never make network calls or require admin signing keys.
      */
     async recordReceipt(params: RecordReceiptParams): Promise<void> {
          logger.info('Soroban stub: recordReceipt', {
               txId: params.txId,
               txType: params.txType,
               amountUsdc: params.amountUsdc,
               dealId: params.dealId,
          })
     }

     getConfig(): SorobanConfig {
          return { ...this.config }
     }

     private simpleHash(str: string): number {
          let hash = 0
          if (this.config.seed !== undefined) {
               const seedStr = typeof this.config.seed === 'number' ? this.config.seed.toString() : this.config.seed
               for (let i = 0; i < seedStr.length; i++) {
                    const char = seedStr.charCodeAt(i)
                    hash = ((hash << 5) - hash) + char
                    hash = hash & hash
               }
          }
          for (let i = 0; i < str.length; i++) {
               const char = str.charCodeAt(i)
               hash = ((hash << 5) - hash) + char
               hash = hash & hash
          }
          return Math.abs(hash)
     }

     private _ledger = 1000
     async getReceiptEvents(fromLedger: number | null): Promise<RawReceiptEvent[]> {
          const ledger = (fromLedger ?? this._ledger) + 1
          this._ledger = ledger
          return [{
               ledger, txHash: `stub_${ledger}`, contractId: this.config.contractId ?? 'stub',
               data: {
                    tx_id: `txid_${ledger}`, tx_type: 'PAYMENT', deal_id: `deal_${ledger % 5}`,
                    amount_usdc: '10000000', external_ref: `txid_${ledger}` // Contract stores as 'external_ref' (same as tx_id)
               }
          }]
     }

     async getTimelockEvents(fromLedger: number | null): Promise<any[]> {
          const ledger = (fromLedger ?? this._ledger) + 1
          this._ledger = ledger
          // Only emit an event occasionally to simulate a realistic queue
          if (ledger % 10 !== 0) return []
          
          return [{
               ledger, 
               txHash: `tx_${ledger}`, 
               contractId: this.config.contractId ?? 'stub_timelock',
               topic: ['governance', 'queued'],
               data: [
                    `hash_${ledger}`, // tx_hash_n
                    'StakingPool',
                    'pause',
                    [],
                    Math.floor(Date.now() / 1000) + 3600 // eta
               ]
          }]
     }

     async executeTimelock(txHash: string, target: string, functionName: string, args: any[], eta: number): Promise<string> {
    logger.info('Soroban stub: executeTimelock', { txHash, target, functionName, args, eta })
    return `stub_stellar_tx_hash_execute_${txHash}`
  }

  async cancelTimelock(txHash: string): Promise<string> {
    logger.info('Soroban stub: cancelTimelock', { txHash })
    return `stub_stellar_tx_hash_cancel_${txHash}`
  }

  async stakeBond(inspectorId: string, amount: bigint): Promise<void> {
       StubSorobanAdapter.stubBonds.set(inspectorId, amount)
       logger.debug('Soroban stub: stakeBond', { inspectorId, amount: amount.toString() })
  }

  async unstakeBond(inspectorId: string): Promise<void> {
       StubSorobanAdapter.stubBonds.delete(inspectorId)
       logger.debug('Soroban stub: unstakeBond', { inspectorId })
  }

  async isBonded(inspectorId: string): Promise<boolean> {
       const bonded = StubSorobanAdapter.stubBonds.has(inspectorId)
       logger.debug('Soroban stub: isBonded', { inspectorId, bonded })
       return bonded
  }

  async getBond(inspectorId: string): Promise<{ isBonded: boolean; amount: bigint }> {
       const amount = StubSorobanAdapter.stubBonds.get(inspectorId) ?? 0n
       const bonded = StubSorobanAdapter.stubBonds.has(inspectorId)
       logger.debug('Soroban stub: getBond', { inspectorId, bonded, amount: amount.toString() })
       return { isBonded: bonded, amount }
  }

  // Admin operations (stub implementations)
     async pause(contractId: string): Promise<string> {
          logger.info('Soroban stub: pause', { contractId })
          return 'stub_tx_hash_pause'
     }

     async unpause(contractId: string): Promise<string> {
          logger.info('Soroban stub: unpause', { contractId })
          return 'stub_tx_hash_unpause'
     }

     async setOperator(contractId: string, operatorAddress: string | null): Promise<string> {
          logger.info('Soroban stub: setOperator', { contractId, operatorAddress })
          return 'stub_tx_hash_set_operator'
     }

     async init(contractId: string, adminAddress: string, operatorAddress?: string): Promise<string> {
          logger.info('Soroban stub: init', { contractId, adminAddress, operatorAddress })
          return 'stub_tx_hash_init'
     }

     async syncDealStatus(params: SyncDealStatusParams): Promise<void> {
          logger.info('Soroban stub: syncDealStatus', { ...params })
     }

async requestRentRelease(params: RequestRentReleaseParams): Promise<void> {
          logger.info('Soroban stub: requestRentRelease', { ...params })
     }

     async challengeRentRelease(params: ChallengeRentReleaseParams): Promise<void> {
          logger.info('Soroban stub: challengeRentRelease', { ...params })
     }

     async resolveRentDispute(params: ResolveRentDisputeParams): Promise<void> {
          logger.info('Soroban stub: resolveRentDispute', { ...params })
     }

     async settleRentReleaseTimeout(params: SettleRentReleaseTimeoutParams): Promise<void> {
          logger.info('Soroban stub: settleRentReleaseTimeout', { ...params })
     }

     async settleDisputeTimeout(params: SettleDisputeTimeoutParams): Promise<void> {
          logger.info('Soroban stub: settleDisputeTimeout', { ...params })
     }

     async registerRentToOwnDeal(params: RegisterRentToOwnDealParams): Promise<void> {
          logger.info('Soroban stub: registerRentToOwnDeal', { ...params })
     }

     async recordRentToOwnEquityPayment(params: RecordRentToOwnEquityPaymentParams): Promise<void> {
          logger.info('Soroban stub: recordRentToOwnEquityPayment', { ...params })
     }

     async completeRentToOwnDeal(params: RentToOwnDealActionParams): Promise<void> {
          logger.info('Soroban stub: completeRentToOwnDeal', { ...params })
     }

     async defaultRentToOwnDeal(params: RentToOwnDealActionParams): Promise<void> {
          logger.info('Soroban stub: defaultRentToOwnDeal', { ...params })
     }

     async updateTenantReputation(tenantId: string, record: TenantReputationRecord): Promise<void> {
          const updated: TenantReputationRecord = {
               ...record,
               lastUpdated: BigInt(Math.floor(Date.now() / 1000)),
          }
          StubSorobanAdapter.stubReputations.set(tenantId, updated)
          logger.info('Soroban stub: updateTenantReputation', { tenantId, compositeScore: record.compositeScore })
     }

     async getTenantReputation(tenantId: string): Promise<TenantReputationRecord | null> {
          const record = StubSorobanAdapter.stubReputations.get(tenantId) ?? null
          logger.debug('Soroban stub: getTenantReputation', { tenantId, found: record !== null })
          return record
     }

     /**
      * Deterministic stub price: matches the default FX_RATE_NGN_PER_USDC
      * (1600) scaled to the contract's 7-decimal precision, always fresh.
      */
     async getOraclePrice(pair: string): Promise<OraclePriceReading> {
          const decimals = 7
          const price = 1600n * 10n ** BigInt(decimals)
          logger.debug('Soroban stub: getOraclePrice', { pair, price: price.toString() })
          return { price, decimals, updatedAt: Math.floor(Date.now() / 1000), sequence: 1 }
     }

     async isOraclePriceStale(pair: string): Promise<boolean> {
          logger.debug('Soroban stub: isOraclePriceStale', { pair })
          return false
     }

     // Direct query methods for transaction-receipt-contract (stub implementations)
     async getReceiptById(txId: string): Promise<OnChainReceipt | null> {
          logger.debug('Soroban stub: getReceiptById', { txId })
          // Return null for non-existent receipts in stub mode
          return null
     }

     async listReceiptsByDeal(dealId: string, limit: number, cursor?: number): Promise<OnChainReceipt[]> {
          logger.debug('Soroban stub: listReceiptsByDeal', { dealId, limit, cursor })
          // Return empty array in stub mode
          return []
     }

     async listReceiptsByUser(userAddress: string, limit: number, cursor?: number): Promise<OnChainReceipt[]> {
          logger.debug('Soroban stub: listReceiptsByUser', { userAddress, limit, cursor })
          // Return empty array in stub mode
          return []
     }

     // Allowlist registry methods (stub implementations)
     async addToAllowlist(address: string, label: string, expiresAt?: number): Promise<string> {
          logger.debug('Soroban stub: addToAllowlist', { address, label, expiresAt })
          // Return stub transaction hash
          return `stub_allowlist_add_${address}`
     }

     async removeFromAllowlist(address: string): Promise<string> {
          logger.debug('Soroban stub: removeFromAllowlist', { address })
          // Return stub transaction hash
          return `stub_allowlist_remove_${address}`
     }

     async isAllowlisted(address: string): Promise<boolean> {
          logger.debug('Soroban stub: isAllowlisted', { address })
          // Return false in stub mode (no actual allowlist)
          return false
     }

     async getAllowlistEntry(address: string): Promise<import('./adapter.js').AllowlistEntry | null> {
          logger.debug('Soroban stub: getAllowlistEntry', { address })
          // Return null in stub mode
          return null
     }

     // rent_wallet contract methods (stub implementations)
     async rentWalletCredit(account: string, amount: bigint): Promise<string> {
          logger.debug('Soroban stub: rentWalletCredit', { account, amount: amount.toString() })
          return `stub_rent_wallet_credit_${account}_${amount}`
     }

     async rentWalletDebit(account: string, amount: bigint): Promise<string> {
          logger.debug('Soroban stub: rentWalletDebit', { account, amount: amount.toString() })
          return `stub_rent_wallet_debit_${account}_${amount}`
     }

     async rentWalletBalance(account: string): Promise<bigint> {
          logger.debug('Soroban stub: rentWalletBalance', { account })
          return BigInt(0)
     }

     // vesting_schedule contract methods (#1911). These follow the contract's rules
     // (see contracts/vesting_schedule) so that routes can be tested end to end.
     async createVestingSchedule(params: CreateVestingScheduleParams): Promise<string> {
          const { beneficiary, totalAmount, startTime, cliffTime, endTime, revocable } = params
          if (totalAmount <= 0n) {
               throw new Error('Stub: vesting amount must be positive')
          }
          if (!(startTime < endTime && startTime <= cliffTime && cliffTime <= endTime)) {
               throw new Error('Stub: invalid vesting schedule times')
          }
          if (StubSorobanAdapter.stubVestings.has(beneficiary)) {
               throw new Error('Stub: vesting schedule already exists for beneficiary')
          }

          StubSorobanAdapter.stubVestings.set(beneficiary, {
               beneficiary,
               totalAmount,
               claimedAmount: 0n,
               startTime,
               cliffTime,
               endTime,
               revocable,
               revoked: false,
          })
          logger.debug('Soroban stub: createVestingSchedule', { beneficiary, totalAmount: totalAmount.toString() })
          return `stub_tx_hash_create_vesting_${beneficiary}`
     }

     async revokeVesting(beneficiary: string): Promise<string> {
          const record = StubSorobanAdapter.stubVestings.get(beneficiary)
          if (!record) {
               throw new Error('Stub: no vesting schedule for beneficiary')
          }
          if (!record.revocable) {
               throw new Error('Stub: vesting schedule is not revocable')
          }
          if (record.revoked) {
               throw new Error('Stub: vesting schedule already revoked')
          }

          const now = Math.floor(Date.now() / 1000)
          const vested = vestedAmount(
               record.totalAmount,
               BigInt(record.startTime),
               BigInt(record.cliffTime),
               BigInt(record.endTime),
               BigInt(now),
          )
          // Same truncation as the contract: nothing vests after the revocation time.
          const cutoff = Math.max(now, record.startTime)
          StubSorobanAdapter.stubVestings.set(beneficiary, {
               ...record,
               totalAmount: vested,
               claimedAmount: vested,
               endTime: cutoff,
               cliffTime: Math.min(record.cliffTime, cutoff),
               revoked: true,
          })
          logger.debug('Soroban stub: revokeVesting', { beneficiary, vested: vested.toString() })
          return `stub_tx_hash_revoke_vesting_${beneficiary}`
     }

     async getVestingSchedule(beneficiary: string): Promise<VestingScheduleRecord | null> {
          const record = StubSorobanAdapter.stubVestings.get(beneficiary)
          return record ? { ...record } : null
     }

     async getClaimableVested(beneficiary: string): Promise<bigint> {
          const record = StubSorobanAdapter.stubVestings.get(beneficiary)
          return record ? this.claimableFor(record) : 0n
     }

     async prepareVestingClaim(beneficiary: string): Promise<string> {
          const contractId = this.requireVestingContractId()
          const tx = new TransactionBuilder(new Account(beneficiary, '0'), {
               fee: '100',
               networkPassphrase: this.config.networkPassphrase,
          })
               .addOperation(buildVestingClaimOperation(contractId, beneficiary))
               .setTimeout(300)
               .build()
          return tx.toXDR()
     }

     async submitVestingClaim(signedXdr: string, beneficiary: string): Promise<string> {
          const contractId = this.requireVestingContractId()
          assertVestingClaimXdr(signedXdr, contractId, this.config.networkPassphrase, beneficiary)

          const record = StubSorobanAdapter.stubVestings.get(beneficiary)
          const claimable = record ? this.claimableFor(record) : 0n
          if (!record || claimable <= 0n) {
               throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Nothing vested to claim')
          }

          StubSorobanAdapter.stubVestings.set(beneficiary, {
               ...record,
               claimedAmount: record.claimedAmount + claimable,
          })
          return `stub_tx_hash_claim_vesting_${beneficiary}`
     }

     // epoch_rewards contract (#1965), in memory.
     async epochRewardsCurrentEpoch(): Promise<number> {
          this.requireEpochRewardsId()
          return StubSorobanAdapter.stubEpochRewards.currentEpoch()
     }

     async epochRewardsGetEpoch(epochNumber: number): Promise<EpochRewardsEpoch | null> {
          this.requireEpochRewardsId()
          return StubSorobanAdapter.stubEpochRewards.getEpoch(epochNumber)
     }

     async epochRewardsTotalStaked(): Promise<bigint> {
          this.requireEpochRewardsId()
          return StubSorobanAdapter.stubEpochRewards.totalStaked()
     }

     async epochRewardsGetClaimable(user: string): Promise<bigint> {
          this.requireEpochRewardsId()
          return StubSorobanAdapter.stubEpochRewards.claimable(user)
     }

     async epochRewardsGetStake(user: string): Promise<bigint | null> {
          this.requireEpochRewardsId()
          return StubSorobanAdapter.stubEpochRewards.getStake(user)
     }

     async epochRewardsFund(amount: bigint): Promise<string> {
          this.requireEpochRewardsId()
          StubSorobanAdapter.stubEpochRewards.fund(amount)
          return `stub_tx_hash_epoch_fund_${amount}`
     }

     async epochRewardsSeal(targetEpoch: number, nextEpochDurationSecs: number): Promise<string> {
          this.requireEpochRewardsId()
          StubSorobanAdapter.stubEpochRewards.seal(targetEpoch, nextEpochDurationSecs)
          return `stub_tx_hash_epoch_seal_${targetEpoch}`
     }

     private epochRewardsArgs(call: EpochRewardsCall, user: string, amount?: bigint): xdr.ScVal[] {
          const userArg = nativeToScVal(new Address(user))
          if (call === 'claim') return [userArg]
          if (amount === undefined || amount <= 0n) {
               throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Amount must be positive')
          }
          return [userArg, nativeToScVal(amount, { type: 'i128' })]
     }

     async prepareEpochRewardsCall(call: EpochRewardsCall, user: string, amount?: bigint): Promise<string> {
          const contractId = this.requireEpochRewardsId()
          return this.buildUnsigned(contractId, user, call, this.epochRewardsArgs(call, user, amount))
     }

     async submitEpochRewardsCall(
          signedXdr: string,
          call: EpochRewardsCall,
          user: string,
          amount?: bigint,
     ): Promise<string> {
          const contractId = this.requireEpochRewardsId()
          assertSignedInvocation(signedXdr, {
               contractId,
               functionName: call,
               args: this.epochRewardsArgs(call, user, amount),
               signer: user,
               networkPassphrase: this.config.networkPassphrase,
               label: `epoch rewards ${call}`,
          })
          const book = StubSorobanAdapter.stubEpochRewards
          if (call === 'stake') book.stake(user, amount!)
          else if (call === 'unstake') book.unstake(user, amount!)
          else book.claim(user)
          return `stub_tx_hash_epoch_${call}_${user}`
     }

     // multisig_admin contract (#1972), in memory.
     multisigTargetFor(contract: 'dealEscrow' | 'contractAccess'): string | undefined {
          return contract === 'dealEscrow' ? this.config.dealEscrowId : this.config.contractAccessId
     }

     multisigEnabled(): boolean {
          return !!this.config.multisigAdminId
     }

     multisigContractId(): string | undefined {
          return this.config.multisigAdminId
     }

     /** The stub's platform key: the configured admin secret's account, or a fixed test key. */
     private stubAdminAddress(): string {
          return this.config.adminSecret
               ? Keypair.fromSecret(this.config.adminSecret).publicKey()
               : Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()
     }

     /** Test helper: restarts the epoch_rewards stub with epochs of `durationSecs`. */
     public static _testOnlyConfigureEpochs(durationSecs: number): void {
          this.stubEpochRewards = new StubEpochRewards(durationSecs)
     }

     /** Test helper: sets the multisig's signers and threshold. */
     public static _testOnlyConfigureMultisig(config: MultisigConfig): void {
          this.stubMultisig.configure(config)
     }

     /** Test helper: the calls proposals have executed so far. */
     public static _testOnlyExecutedMultisigCalls() {
          return [...this.stubMultisig.executedCalls]
     }

     async multisigGetConfig(): Promise<MultisigConfig> {
          this.requireMultisigId()
          return StubSorobanAdapter.stubMultisig.getConfig()
     }

     async multisigListProposals(status?: MultisigProposalStatus): Promise<MultisigProposal[]> {
          this.requireMultisigId()
          return StubSorobanAdapter.stubMultisig.list(status)
     }

     async multisigGetProposal(proposalId: number): Promise<MultisigProposal | null> {
          this.requireMultisigId()
          return StubSorobanAdapter.stubMultisig.get(proposalId)
     }

     async multisigPropose(
          target: string,
          functionName: string,
          args: MultisigArg[],
     ): Promise<{ txHash: string; proposalId?: number }> {
          this.requireMultisigId()
          const proposalId = StubSorobanAdapter.stubMultisig.propose(
               this.stubAdminAddress(),
               target,
               functionName,
               args,
          )
          return { txHash: `stub_tx_hash_multisig_propose_${proposalId}`, proposalId }
     }

     private multisigArgs(call: MultisigCall, params: MultisigCallParams): xdr.ScVal[] {
          const signer = nativeToScVal(new Address(params.signer))
          if (call === 'propose') {
               if (!params.target || !params.functionName) {
                    throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'propose needs a target and function')
               }
               return [
                    signer,
                    nativeToScVal(new Address(params.target)),
                    nativeToScVal(params.functionName, { type: 'symbol' }),
                    xdr.ScVal.scvVec((params.args ?? []).map(encodeMultisigArg)),
               ]
          }
          if (params.proposalId === undefined) {
               throw new AppError(ErrorCode.VALIDATION_ERROR, 400, `${call} needs a proposal id`)
          }
          return [signer, nativeToScVal(BigInt(params.proposalId), { type: 'u64' })]
     }

     async prepareMultisigCall(call: MultisigCall, params: MultisigCallParams): Promise<string> {
          const contractId = this.requireMultisigId()
          return this.buildUnsigned(contractId, params.signer, call, this.multisigArgs(call, params))
     }

     async submitMultisigCall(
          signedXdr: string,
          call: MultisigCall,
          params: MultisigCallParams,
     ): Promise<string> {
          const contractId = this.requireMultisigId()
          assertSignedInvocation(signedXdr, {
               contractId,
               functionName: call,
               args: this.multisigArgs(call, params),
               signer: params.signer,
               networkPassphrase: this.config.networkPassphrase,
               label: `multisig ${call}`,
          })
          const book = StubSorobanAdapter.stubMultisig
          let suffix = ''
          if (call === 'propose') {
               suffix = String(book.propose(params.signer, params.target!, params.functionName!, params.args ?? []))
          } else if (call === 'approve') {
               book.approve(params.signer, params.proposalId!)
               suffix = String(params.proposalId)
          } else if (call === 'revoke_approval') {
               book.revokeApproval(params.signer, params.proposalId!)
               suffix = String(params.proposalId)
          } else {
               book.execute(params.signer, params.proposalId!)
               suffix = String(params.proposalId)
          }
          return `stub_tx_hash_multisig_${call}_${suffix}`
     }

     private buildUnsigned(contractId: string, signer: string, fn: string, args: xdr.ScVal[]): string {
          return new TransactionBuilder(new Account(signer, '0'), {
               fee: '100',
               networkPassphrase: this.config.networkPassphrase,
          })
               .addOperation(buildInvokeOperation(contractId, fn, args))
               .setTimeout(300)
               .build()
               .toXDR()
     }

     private requireEpochRewardsId(): string {
          if (!this.config.epochRewardsId) {
               throw new Error('SOROBAN_EPOCH_REWARDS_ID not configured')
          }
          return this.config.epochRewardsId
     }

     private requireMultisigId(): string {
          if (!this.config.multisigAdminId) {
               throw new Error('MULTISIG_ADMIN_ID not configured')
          }
          return this.config.multisigAdminId
     }

     private requireVestingContractId(): string {
          if (!this.config.vestingScheduleId) {
               throw new Error('SOROBAN_VESTING_SCHEDULE_ID not configured')
          }
          return this.config.vestingScheduleId
     }

     private claimableFor(record: VestingScheduleRecord): bigint {
          const now = BigInt(Math.floor(Date.now() / 1000))
          const vested = vestedAmount(
               record.totalAmount,
               BigInt(record.startTime),
               BigInt(record.cliffTime),
               BigInt(record.endTime),
               now,
          )
          const claimable = vested - record.claimedAmount
          return claimable > 0n ? claimable : 0n
     }

     // slashing_module contract methods (stub implementations)
     async submitEvidence(submitter: string, commitment: string, actor: string, offence: string): Promise<number> {
          logger.debug('Soroban stub: submitEvidence', { submitter, actor, offence })
          return 1 // Return stub slash ID
     }

     async revealEvidence(submitter: string, slashId: number, evidence: string, salt: string): Promise<void> {
          logger.debug('Soroban stub: revealEvidence', { submitter, slashId })
     }

     async proposeSlash(submitter: string, actor: string, penaltyBps: number): Promise<number> {
          logger.debug('Soroban stub: proposeSlash', { submitter, actor, penaltyBps })
          return 1 // Return stub slash ID
     }

     async finalizeSlash(caller: string, slashId: number): Promise<void> {
          logger.debug('Soroban stub: finalizeSlash', { caller, slashId })
     }

     async cancelSlash(admin: string, slashId: number): Promise<void> {
          logger.debug('Soroban stub: cancelSlash', { admin, slashId })
     }

     // bond_collateral contract methods (stub implementations)
     async depositBond(inspector: string, amount: bigint): Promise<void> {
          logger.debug('Soroban stub: depositBond', { inspector, amount: amount.toString() })
     }

     async withdrawBond(inspector: string, amount: bigint): Promise<void> {
          logger.debug('Soroban stub: withdrawBond', { inspector, amount: amount.toString() })
     }

     async getBondBalance(inspector: string): Promise<bigint> {
          logger.debug('Soroban stub: getBondBalance', { inspector })
          return BigInt(0)
     }

     // ── whistleblower_rewards contract ───────────────────────────────────────────
     
     async allocateReward(whistleblower: string, amount: bigint): Promise<string> {
          logger.info('Soroban stub: allocateReward', { whistleblower, amount: amount.toString() })
          return 'stub_tx_hash_allocate_reward'
     }

     async claimReward(whistleblower: string): Promise<bigint> {
          logger.info('Soroban stub: claimReward', { whistleblower })
          const hash = this.simpleHash(`claimable:${this.config.whistleblowerRewardsId ?? 'stub'}:${whistleblower}`)
          return BigInt(hash % 100) * 1_000_000n
     }

     async getClaimableReward(whistleblower: string): Promise<bigint> {
          logger.debug('Soroban stub: getClaimableReward', { whistleblower })
          const hash = this.simpleHash(`claimable:${this.config.whistleblowerRewardsId ?? 'stub'}:${whistleblower}`)
          return BigInt(hash % 100) * 1_000_000n
     }

     // ── rent_payments contract ──────────────────────────────────────────────────
     
     async createRentPaymentReceipt(
          dealId: string,
          amount: bigint,
          payer: string,
          recipient: string,
          timestamp: number
     ): Promise<string> {
          logger.info('Soroban stub: createRentPaymentReceipt', {
               dealId,
               amount: amount.toString(),
               payer,
               recipient,
               timestamp,
          })
          return 'stub_tx_hash_create_rent_payment_receipt'
     }

     async listRentPaymentReceiptsByDeal(dealId: string, limit: number): Promise<any[]> {
          logger.debug('Soroban stub: listRentPaymentReceiptsByDeal', { dealId, limit })
          return []
     }

     async rentPaymentReceiptCount(dealId: string): Promise<number> {
          logger.debug('Soroban stub: rentPaymentReceiptCount', { dealId })
          return 0
     }

     // ── deal_escrow circuit-breaker ─────────────────────────────────────────────
     
     async freeze(): Promise<string> {
          logger.info('Soroban stub: freeze')
          return 'stub_tx_hash_freeze'
     }

     async isFrozen(): Promise<boolean> {
          logger.debug('Soroban stub: isFrozen')
          return false
     }

     async proposeDrain(destination: string): Promise<string> {
          logger.info('Soroban stub: proposeDrain', { destination })
          return 'stub_tx_hash_propose_drain'
     }

     async executeDrain(): Promise<string> {
          logger.info('Soroban stub: executeDrain')
          return 'stub_tx_hash_execute_drain'
     }

     async setRecoveryDelay(delaySeconds: number): Promise<string> {
          logger.info('Soroban stub: setRecoveryDelay', { delaySeconds })
          return 'stub_tx_hash_set_recovery_delay'
     }

     async getCircuitBreakerState(): Promise<{ frozen: boolean; drainProposed: boolean; drainDestination?: string; recoveryDelay: number }> {
          logger.debug('Soroban stub: getCircuitBreakerState')
          return {
               frozen: false,
               drainProposed: false,
               drainDestination: undefined,
               recoveryDelay: 0,
          }
     }
}
