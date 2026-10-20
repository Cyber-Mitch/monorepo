import { loadContractAddresses } from '../config/contractAddresses.js'

export type SorobanConfig = {
  rpcUrl: string
  networkPassphrase: string
  contractId?: string
  timelockId?: string
  stakingPoolId?: string
  stakingRewardsId?: string
  mvpStakingPoolId?: string
  usdcTokenId?: string
  dealEscrowId?: string
  rentPaymentsId?: string
  inspectorBondId?: string
  contractAccessId?: string
  rentToOwnId?: string
  oraclePriceFeedsId?: string
  transactionReceiptId?: string
  allowlistRegistryId?: string
  rentWalletId?: string
  slashingModuleId?: string
  bondCollateralId?: string
  whistleblowerRewardsId?: string
  tenantReputationId?: string
  adminSecret?: string
  seed?: string | number
}

export function getSorobanConfigFromEnv(env: NodeJS.ProcessEnv): SorobanConfig {
  const addresses = loadContractAddresses(env)
  return {
    rpcUrl: env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: env.SOROBAN_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    contractId: addresses.core,
    timelockId: addresses.timelock,
    stakingPoolId: addresses.stakingPool,
    stakingRewardsId: addresses.stakingRewards,
    mvpStakingPoolId: addresses.mvpStakingPool,
    usdcTokenId: addresses.usdcToken,
    dealEscrowId: addresses.dealEscrow,
    rentPaymentsId: addresses.rentPayments,
    inspectorBondId: addresses.inspectorBond,
    contractAccessId: addresses.contractAccess,
    rentToOwnId: addresses.rentToOwn,
    oraclePriceFeedsId: addresses.oraclePriceFeeds,
    transactionReceiptId: addresses.transactionReceipt,
    allowlistRegistryId: addresses.allowlistRegistry,
    rentWalletId: addresses.rentWallet,
    slashingModuleId: addresses.slashingModule,
    bondCollateralId: addresses.bondCollateral,
    whistleblowerRewardsId: addresses.whistleblowerRewards,
    tenantReputationId: addresses.tenantReputation,
    adminSecret: env.SOROBAN_ADMIN_SECRET,
    seed: env.SOROBAN_STUB_SEED,
  }
}
