import { describe, expect, it } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import {
  CONTRACT_ENV_VARS,
  loadContractAddresses,
} from './contractAddresses.js'

const VALID_CONTRACT_ID =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'

describe('contract address config', () => {
  it('loads valid addresses into a typed object and records unset entries', () => {
    expect(StrKey.isValidContract(VALID_CONTRACT_ID)).toBe(true)
    const addresses = loadContractAddresses({
      SOROBAN_DEAL_ESCROW_ID: VALID_CONTRACT_ID,
    })

    expect(addresses.dealEscrow).toBe(VALID_CONTRACT_ID)
    expect(addresses.rentPayments).toBeUndefined()
    expect(Object.keys(addresses)).toEqual(Object.keys(CONTRACT_ENV_VARS))
  })

  it('recognizes SOROBAN_ORACLE_PRICE_FEEDS_ID (issue #1488)', () => {
    expect(CONTRACT_ENV_VARS.oraclePriceFeeds).toBe('SOROBAN_ORACLE_PRICE_FEEDS_ID')

    const addresses = loadContractAddresses({
      SOROBAN_ORACLE_PRICE_FEEDS_ID: VALID_CONTRACT_ID,
    })
    expect(addresses.oraclePriceFeeds).toBe(VALID_CONTRACT_ID)

    expect(() =>
      loadContractAddresses({ SOROBAN_ORACLE_PRICE_FEEDS_ID: 'not-a-contract' }),
    ).toThrow('Invalid Soroban contract ID in SOROBAN_ORACLE_PRICE_FEEDS_ID')
  })

  it('recognizes SOROBAN_VESTING_SCHEDULE_ID (issue #1911)', () => {
    expect(CONTRACT_ENV_VARS.vestingSchedule).toBe('SOROBAN_VESTING_SCHEDULE_ID')

    const addresses = loadContractAddresses({
      SOROBAN_VESTING_SCHEDULE_ID: VALID_CONTRACT_ID,
    })
    expect(addresses.vestingSchedule).toBe(VALID_CONTRACT_ID)
  })

  it('recognizes SOROBAN_EPOCH_REWARDS_ID (issue #1965)', () => {
    expect(CONTRACT_ENV_VARS.epochRewards).toBe('SOROBAN_EPOCH_REWARDS_ID')

    const addresses = loadContractAddresses({ SOROBAN_EPOCH_REWARDS_ID: VALID_CONTRACT_ID })
    expect(addresses.epochRewards).toBe(VALID_CONTRACT_ID)
    expect(() => loadContractAddresses({ SOROBAN_EPOCH_REWARDS_ID: 'nope' })).toThrow(
      'Invalid Soroban contract ID in SOROBAN_EPOCH_REWARDS_ID',
    )
  })

  it('recognizes MULTISIG_ADMIN_ID (issue #1972)', () => {
    expect(CONTRACT_ENV_VARS.multisigAdmin).toBe('MULTISIG_ADMIN_ID')

    const addresses = loadContractAddresses({ MULTISIG_ADMIN_ID: VALID_CONTRACT_ID })
    expect(addresses.multisigAdmin).toBe(VALID_CONTRACT_ID)
    expect(loadContractAddresses({}).multisigAdmin).toBeUndefined()
    expect(() => loadContractAddresses({ MULTISIG_ADMIN_ID: 'nope' })).toThrow(
      'Invalid Soroban contract ID in MULTISIG_ADMIN_ID',
    )
  })

  it('recognizes SOROBAN_MVP_STAKING_POOL_ID (issue #1493)', () => {
    expect(CONTRACT_ENV_VARS.mvpStakingPool).toBe('SOROBAN_MVP_STAKING_POOL_ID')

    const addresses = loadContractAddresses({
      SOROBAN_MVP_STAKING_POOL_ID: VALID_CONTRACT_ID,
    })
    expect(addresses.mvpStakingPool).toBe(VALID_CONTRACT_ID)
  })



  it('fails fast with the offending environment variable', () => {
    expect(() =>
      loadContractAddresses({
        SOROBAN_TENANT_REPUTATION_ID: 'not-a-contract',
      }),
    ).toThrow(
      'Invalid Soroban contract ID in SOROBAN_TENANT_REPUTATION_ID',
    )
  })
})

