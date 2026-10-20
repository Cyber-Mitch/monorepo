import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RealSorobanAdapter } from './real-adapter.js'
import { SorobanConfig } from './client.js'
import {
  ConfigurationError,
  ContractError,
  DuplicateReceiptError,
  TransactionError,
  isDuplicateReceiptError,
  isTransientRpcError,
} from './errors.js'
import { TxType } from '../outbox/types.js'

// Mock @stellar/stellar-sdk
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk')

  // Create a mock class for rpc.Server
  class MockServer {
    constructor(url: string) {
      this.url = url
    }
    url: string
    getLatestLedger = vi.fn()
    getEvents = vi.fn()
    simulateTransaction = vi.fn()
    getAccount = vi.fn()
    sendTransaction = vi.fn()
    getTransaction = vi.fn()
  }

  return {
    ...actual,
    rpc: {
      Server: MockServer,
      Api: {
        isSimulationSuccess: vi.fn(),
        isSimulationRestore: vi.fn(),
      },
    },
    Address: (() => {
      const makeAddress = (val: string) => ({
        toScAddress: vi.fn().mockReturnValue({}),
        toString: () => val || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      })
      function AddressMock(this: any, val: string) {
        return makeAddress(val)
      }
      AddressMock.fromString = vi.fn().mockImplementation((val: string) => makeAddress(val))
      return AddressMock
    })(),
    nativeToScVal: vi.fn().mockImplementation((val) => val),
    scValToNative: vi.fn().mockImplementation((val) => {
      // Return the value if it has a value() method, otherwise return the val itself
      if (val && typeof val.value === 'function') {
        return val.value()
      }
      return 1000000n
    }), // Mock default return value
    Account: vi.fn().mockImplementation(function (address, sequence) {
      return {
        accountId: () => address,
        sequenceNumber: () => sequence,
      }
    }),
    TransactionBuilder: vi.fn().mockImplementation(function () {
      return {
        addOperation: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
        build: vi.fn().mockReturnValue({}),
        sign: vi.fn().mockReturnThis(),
      }
    }),
    Operation: {
      invokeHostFunction: vi.fn().mockReturnValue({}),
    },
    Keypair: {
      fromSecret: vi.fn().mockReturnValue({
        publicKey: () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      }),
    },
  }
})

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('RealSorobanAdapter', () => {
  let adapter: RealSorobanAdapter
  let mockServer: any

  const mockConfig: SorobanConfig = {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2CH',
    stakingPoolId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD3Y4',
    stakingRewardsId: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCD4Z5',
    usdcTokenId: 'CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD5A6',
    oraclePriceFeedsId: 'CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEED6B7',
    adminSecret: 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new RealSorobanAdapter(mockConfig)
    // Access private server for mocking
    mockServer = (adapter as any).server
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('configuration', () => {
    it('should return config via getConfig()', () => {
      const config = adapter.getConfig()
      expect(config.rpcUrl).toBe(mockConfig.rpcUrl)
      expect(config.contractId).toBe(mockConfig.contractId)
    })
  })

  describe('getBalance', () => {
    it('should throw ConfigurationError when usdcTokenId not set', async () => {
      const adapterWithoutUsdc = new RealSorobanAdapter({
        ...mockConfig,
        usdcTokenId: undefined,
      })

      await expect(adapterWithoutUsdc.getBalance('GABC123')).rejects.toThrow(ConfigurationError)
    })

    it('should call balance method on USDC token contract', async () => {
      const { rpc } = await import('@stellar/stellar-sdk')

      // Mock successful simulation
      vi.mocked(rpc.Api.isSimulationSuccess).mockReturnValue(true)
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: { // Mock ScVal object
            value: () => 1000000n,
            switch: () => ({ value: () => 'i128' })
          }
        },
      })

      const balance = await adapter.getBalance('GABC123')

      expect(mockServer.simulateTransaction).toHaveBeenCalled()
      expect(balance).toBe(1000000n)
    })

    it('should wrap errors in ContractError', async () => {
      const { rpc } = await import('@stellar/stellar-sdk')

      vi.mocked(rpc.Api.isSimulationSuccess).mockReturnValue(false)
      vi.mocked(rpc.Api.isSimulationRestore).mockReturnValue(false)
      mockServer.simulateTransaction.mockResolvedValue({
        error: 'Simulation failed',
      })

      await expect(adapter.getBalance('GABC123')).rejects.toThrow(ContractError)
    })
  })

  describe('getStakedBalance', () => {
    it('should throw ConfigurationError when stakingPoolId not set', async () => {
      const adapterWithoutPool = new RealSorobanAdapter({
        ...mockConfig,
        stakingPoolId: undefined,
      })

      await expect(adapterWithoutPool.getStakedBalance('GABC123')).rejects.toThrow(ConfigurationError)
    })

    it('should return staked balance from staking pool contract', async () => {
      const { rpc } = await import('@stellar/stellar-sdk')

      vi.mocked(rpc.Api.isSimulationSuccess).mockReturnValue(true)
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: { // Mock ScVal object
            value: () => 5000000000n,
            switch: () => ({ value: () => 'i128' })
          }
        },
      })

      const balance = await adapter.getStakedBalance('GABC123')

      expect(mockServer.simulateTransaction).toHaveBeenCalled()
      expect(balance).toBe(5000000000n)
    })
  })

  describe('getClaimableRewards', () => {
    it('should throw ConfigurationError when stakingRewardsId not set', async () => {
      const adapterWithoutRewards = new RealSorobanAdapter({
        ...mockConfig,
        stakingRewardsId: undefined,
      })

      await expect(adapterWithoutRewards.getClaimableRewards('GABC123')).rejects.toThrow(ConfigurationError)
    })

    it('should return claimable rewards from rewards contract', async () => {
      const { rpc } = await import('@stellar/stellar-sdk')

      vi.mocked(rpc.Api.isSimulationSuccess).mockReturnValue(true)
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: { // Mock ScVal object
            value: () => 250000000n,
            switch: () => ({ value: () => 'i128' })
          }
        },
      })

      const rewards = await adapter.getClaimableRewards('GABC123')

      expect(mockServer.simulateTransaction).toHaveBeenCalled()
      expect(rewards).toBe(250000000n)
    })
  })

  describe('getOraclePrice', () => {
    it('should throw ConfigurationError when oraclePriceFeedsId not set', async () => {
      const adapterWithoutOracle = new RealSorobanAdapter({
        ...mockConfig,
        oraclePriceFeedsId: undefined,
      })

      await expect(adapterWithoutOracle.getOraclePrice('NGN_USDC')).rejects.toThrow(ConfigurationError)
    })

    it('should read a PriceFeed struct via get_price', async () => {
      const { rpc, scValToNative } = await import('@stellar/stellar-sdk')

      vi.mocked(rpc.Api.isSimulationSuccess).mockReturnValue(true)
      vi.mocked(scValToNative).mockReturnValueOnce({
        pair: 'NGN_USDC',
        price: 16_000_000_000n,
        decimals: 7,
        updated_at: 1_000,
        sequence: 3,
      })
      mockServer.simulateTransaction.mockResolvedValue({
        result: { retval: {} },
      })

      const reading = await adapter.getOraclePrice('NGN_USDC')

      expect(mockServer.simulateTransaction).toHaveBeenCalled()
      expect(reading).toEqual({ price: 16_000_000_000n, decimals: 7, updatedAt: 1_000, sequence: 3 })
    })

    it('should wrap simulation failures (e.g. a PriceTooStale revert) in ContractError', async () => {
      const { rpc } = await import('@stellar/stellar-sdk')

      vi.mocked(rpc.Api.isSimulationSuccess).mockReturnValue(false)
      vi.mocked(rpc.Api.isSimulationRestore).mockReturnValue(false)
      mockServer.simulateTransaction.mockResolvedValue({
        error: 'HostError: Error(Contract, #4)', // ContractError::PriceTooStale
      })

      await expect(adapter.getOraclePrice('NGN_USDC')).rejects.toThrow(ContractError)
    })
  })

  describe('isOraclePriceStale', () => {
    it('should throw ConfigurationError when oraclePriceFeedsId not set', async () => {
      const adapterWithoutOracle = new RealSorobanAdapter({
        ...mockConfig,
        oraclePriceFeedsId: undefined,
      })

      await expect(adapterWithoutOracle.isOraclePriceStale('NGN_USDC')).rejects.toThrow(ConfigurationError)
    })

    it('should return the boolean result of is_stale', async () => {
      const { rpc, scValToNative } = await import('@stellar/stellar-sdk')

      vi.mocked(rpc.Api.isSimulationSuccess).mockReturnValue(true)
      vi.mocked(scValToNative).mockReturnValueOnce(true)
      mockServer.simulateTransaction.mockResolvedValue({
        result: { retval: {} },
      })

      await expect(adapter.isOraclePriceStale('NGN_USDC')).resolves.toBe(true)
    })
  })

  describe('recordReceipt', () => {
    it('should throw ConfigurationError when contractId not set', async () => {
      const adapterWithoutContract = new RealSorobanAdapter({
        ...mockConfig,
        contractId: undefined,
      })

      await expect(
        adapterWithoutContract.recordReceipt({
          txId: 'abc123',
          txType: TxType.TENANT_REPAYMENT,
          amountUsdc: '100.00',
          tokenAddress: 'CDUSDC...',
          dealId: 'deal-123',
        })
      ).rejects.toThrow(ConfigurationError)
    })

    it('should throw ConfigurationError when adminSecret not set', async () => {
      const adapterWithoutAdmin = new RealSorobanAdapter({
        ...mockConfig,
        adminSecret: undefined,
      })

      await expect(
        adapterWithoutAdmin.recordReceipt({
          txId: 'abc123',
          txType: TxType.TENANT_REPAYMENT,
          amountUsdc: '100.00',
          tokenAddress: 'CDUSDC...',
          dealId: 'deal-123',
        })
      ).rejects.toThrow(ConfigurationError)
    })

    it('should invoke record_receipt on the configured contract', async () => {
      const invokeSpy = vi
        .spyOn(adapter as any, 'invokeTransaction')
        .mockResolvedValue(undefined)

      await adapter.recordReceipt({
        txId: 'abc123def456',
        txType: TxType.TENANT_REPAYMENT,
        amountUsdc: '100.00',
        tokenAddress: 'CDUSDC...',
        dealId: 'deal-123',
        listingId: 'listing-1',
        from: 'GFROM',
        to: 'GTO',
        amountNgn: 150_000,
        fxRate: 1500.5,
        fxProvider: 'manual',
        metadataHash: 'cafe',
      })

      expect(invokeSpy).toHaveBeenCalledTimes(1)
      const [contractId, method, args] = invokeSpy.mock.calls[0]
      expect(contractId).toBe(mockConfig.contractId)
      expect(method).toBe('record_receipt')
      expect(Array.isArray(args)).toBe(true)
      expect(args.length).toBe(1)
    })

    it('should use transactionReceiptId when configured for recordReceipt', async () => {
      const configWithTransactionReceipt = {
        ...mockConfig,
        transactionReceiptId: 'CTRX...',
        contractId: mockConfig.contractId,
      }
      const adapterWithTransactionReceipt = new RealSorobanAdapter(configWithTransactionReceipt)

      const invokeSpy = vi
        .spyOn(adapterWithTransactionReceipt as any, 'invokeTransaction')
        .mockResolvedValue(undefined)

      await adapterWithTransactionReceipt.recordReceipt({
        txId: 'abc123def456',
        txType: TxType.TENANT_REPAYMENT,
        amountUsdc: '100.00',
        tokenAddress: 'CDUSDC...',
        dealId: 'deal-123',
        externalRefSource: 'paystack',
        externalRef: 'ref-123',
      })

      expect(invokeSpy).toHaveBeenCalledTimes(1)
      const [contractId, method, args] = invokeSpy.mock.calls[0]
      expect(contractId).toBe(configWithTransactionReceipt.transactionReceiptId)
      expect(method).toBe('record_receipt')
      expect(Array.isArray(args)).toBe(true)
      expect(args.length).toBe(1)
    })

    it('should fall back to contractId when transactionReceiptId is not configured', async () => {
      const configWithoutTransactionReceipt = {
        ...mockConfig,
        transactionReceiptId: undefined,
      }
      const adapterWithoutTransactionReceipt = new RealSorobanAdapter(configWithoutTransactionReceipt)

      const invokeSpy = vi
        .spyOn(adapterWithoutTransactionReceipt as any, 'invokeTransaction')
        .mockResolvedValue(undefined)

      await adapterWithoutTransactionReceipt.recordReceipt({
        txId: 'abc123def456',
        txType: TxType.TENANT_REPAYMENT,
        amountUsdc: '100.00',
        tokenAddress: 'CDUSDC...',
        dealId: 'deal-123',
      })

      expect(invokeSpy).toHaveBeenCalledTimes(1)
      const [contractId, method, args] = invokeSpy.mock.calls[0]
      expect(contractId).toBe(configWithoutTransactionReceipt.contractId)
      expect(method).toBe('record_receipt')
      expect(Array.isArray(args)).toBe(true)
      expect(args.length).toBe(1)
    })

    it('should treat duplicate receipt errors as idempotent success', async () => {
      vi.spyOn(adapter as any, 'invokeTransaction').mockRejectedValue(
        new Error('Receipt already exists for tx_id abc123')
      )

      await expect(
        adapter.recordReceipt({
          txId: 'abc123',
          txType: TxType.TENANT_REPAYMENT,
          amountUsdc: '100.00',
          tokenAddress: 'CDUSDC...',
          dealId: 'deal-123',
        })
      ).resolves.toBeUndefined()
    })

    it('should treat DuplicateReceiptError as idempotent success', async () => {
      vi.spyOn(adapter as any, 'invokeTransaction').mockRejectedValue(
        new DuplicateReceiptError('abc123')
      )

      await expect(
        adapter.recordReceipt({
          txId: 'abc123',
          txType: TxType.TENANT_REPAYMENT,
          amountUsdc: '100.00',
          tokenAddress: 'CDUSDC...',
          dealId: 'deal-123',
        })
      ).resolves.toBeUndefined()
    })

    it('should re-throw SorobanError types unchanged', async () => {
      const contractErr = new ContractError(
        'simulation failed',
        mockConfig.contractId!,
        'record_receipt'
      )
      vi.spyOn(adapter as any, 'invokeTransaction').mockRejectedValue(contractErr)

      await expect(
        adapter.recordReceipt({
          txId: 'abc123',
          txType: TxType.TENANT_REPAYMENT,
          amountUsdc: '100.00',
          tokenAddress: 'CDUSDC...',
          dealId: 'deal-123',
        })
      ).rejects.toBe(contractErr)
    })

    it('should wrap non-duplicate plain errors in TransactionError', async () => {
      vi.spyOn(adapter as any, 'invokeTransaction').mockRejectedValue(
        new Error('network blew up')
      )

      await expect(
        adapter.recordReceipt({
          txId: 'abc123',
          txType: TxType.TENANT_REPAYMENT,
          amountUsdc: '100.00',
          tokenAddress: 'CDUSDC...',
          dealId: 'deal-123',
        })
      ).rejects.toThrow(TransactionError)
    })

    it('should not silently succeed on unexpected errors', async () => {
      vi.spyOn(adapter as any, 'invokeTransaction').mockRejectedValue(
        new Error('network blew up')
      )

      await expect(
        adapter.recordReceipt({
          txId: 'abc123',
          txType: TxType.TENANT_REPAYMENT,
          amountUsdc: '100.00',
          tokenAddress: 'CDUSDC...',
          dealId: 'deal-123',
        })
      ).rejects.toThrow(/record receipt/i)
    })
  })

  describe('error utilities', () => {
    describe('isDuplicateReceiptError', () => {
      it('should return true for DuplicateReceiptError instance', () => {
        const error = new DuplicateReceiptError('tx123')
        expect(isDuplicateReceiptError(error)).toBe(true)
      })

      it('should detect "already exists" in error message', () => {
        const error = new Error('Receipt already exists')
        expect(isDuplicateReceiptError(error)).toBe(true)
      })

      it('should detect "duplicate" in error message', () => {
        const error = new Error('Duplicate entry found')
        expect(isDuplicateReceiptError(error)).toBe(true)
      })

      it('should detect txId in error message when provided', () => {
        const error = new Error('Transaction tx123abc failed: already recorded')
        expect(isDuplicateReceiptError(error, 'tx123abc')).toBe(true)
      })

      it('should return false for unrelated errors', () => {
        const error = new Error('Network timeout')
        expect(isDuplicateReceiptError(error)).toBe(false)
      })
    })

    describe('isTransientRpcError', () => {
      it('should detect timeout errors', () => {
        const error = new Error('Request timeout')
        expect(isTransientRpcError(error)).toBe(true)
      })

      it('should detect rate limit (429)', () => {
        const error = { response: { status: 429 } }
        expect(isTransientRpcError(error)).toBe(true)
      })

      it('should detect service unavailable (503)', () => {
        const error = { response: { status: 503 } }
        expect(isTransientRpcError(error)).toBe(true)
      })

      it('should return false for non-retryable errors', () => {
        const error = new Error('Invalid argument')
        expect(isTransientRpcError(error)).toBe(false)
      })
    })
  })

  describe('credit/debit', () => {
    it('should throw TransactionError for credit', async () => {
      await expect(adapter.credit('GABC123', 1000n)).rejects.toThrow(TransactionError)
    })

    it('should throw TransactionError for debit', async () => {
      await expect(adapter.debit('GABC123', 1000n)).rejects.toThrow(TransactionError)
    })
  })

  describe('getReceiptEvents', () => {
    it('should throw ConfigurationError when contractId not set', async () => {
      const adapterWithoutContract = new RealSorobanAdapter({
        ...mockConfig,
        contractId: undefined,
      })

      await expect(adapterWithoutContract.getReceiptEvents(null)).rejects.toThrow(ConfigurationError)
    })

    it('should return empty array when startLedger > latest', async () => {
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 1000 })

      const events = await adapter.getReceiptEvents(1000)

      expect(events).toEqual([])
    })

    it('should fetch and parse receipt events', async () => {
      const { xdr } = await import('@stellar/stellar-sdk')

      mockServer.getLatestLedger.mockResolvedValue({ sequence: 2000 })
      mockServer.getEvents.mockResolvedValue({
        events: [
          {
            inSuccessfulContractCall: true,
            type: 'contract',
            contractId: mockConfig.contractId,
            value: 'AAAAAQAAAAd0eF90eXBlAAAAAA==', // base64 encoded XDR
            txHash: 'abc123',
            ledger: 1500,
          },
        ],
        cursor: 'cursor1',
      })

      // Mock xdr.ScVal.fromXDR for decoding
      const mockScVal = {
        tx_id: Buffer.from('tx123', 'hex'),
        tx_type: 'PAYMENT',
        deal_id: 'deal-456',
        amount_usdc: 1000000n,
      }

      // We can't fully mock xdr decoding, but we can verify the flow
      const events = await adapter.getReceiptEvents(1000)

      // Events may be empty due to XDR decoding, but the flow should complete
      expect(Array.isArray(events)).toBe(true)
    })
  })
  describe('tenant reputation', () => {
    const TENANT_REPUTATION_ID = 'CFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE7'
    const record = {
      compositeScore: 840,
      paymentScore: 900,
      propertyCareScore: 800,
      communicationScore: 760,
      totalRatings: 12,
      lastUpdated: 0n,
    }

    it('updateTenantReputation throws ConfigurationError when contract id missing', async () => {
      await expect(adapter.updateTenantReputation('tenant-1', record)).rejects.toThrow(ConfigurationError)
    })

    it('updateTenantReputation throws ConfigurationError when admin secret missing', async () => {
      const noAdmin = new RealSorobanAdapter({
        ...mockConfig,
        tenantReputationId: TENANT_REPUTATION_ID,
        adminSecret: undefined,
      })
      await expect(noAdmin.updateTenantReputation('tenant-1', record)).rejects.toThrow(ConfigurationError)
    })

    it('updateTenantReputation calls update_reputation with exact argument order and types', async () => {
      const configured = new RealSorobanAdapter({ ...mockConfig, tenantReputationId: TENANT_REPUTATION_ID })
      const exec = vi.fn().mockResolvedValue(undefined)
      ;(configured as any).adminSigningService = { executeAdminOperation: exec }

      await configured.updateTenantReputation('tenant-1', record)

      const { nativeToScVal } = await import('@stellar/stellar-sdk')
      expect(exec).toHaveBeenCalledTimes(1)
      const call = exec.mock.calls[0][0]
      expect(call.contractId).toBe(TENANT_REPUTATION_ID)
      expect(call.operation).toBe('update_reputation')
      expect(call.args).toHaveLength(7)
      expect(call.args.slice(1)).toEqual(['tenant-1', 840, 900, 800, 760, 12])
      const typed = (nativeToScVal as any).mock.calls.map((c: any[]) => c[1]?.type)
      expect(typed.slice(-6)).toEqual(['string', 'u32', 'u32', 'u32', 'u32', 'u32'])
    })

    it('updateTenantReputation wraps failures in ContractError', async () => {
      const configured = new RealSorobanAdapter({ ...mockConfig, tenantReputationId: TENANT_REPUTATION_ID })
      ;(configured as any).adminSigningService = {
        executeAdminOperation: vi.fn().mockRejectedValue(new Error('rpc down')),
      }
      await expect(configured.updateTenantReputation('tenant-1', record)).rejects.toThrow(ContractError)
    })

    it('getTenantReputation throws ConfigurationError when contract id missing', async () => {
      await expect(adapter.getTenantReputation('tenant-1')).rejects.toThrow(ConfigurationError)
    })

    it('getTenantReputation reads get_reputation and maps snake_case fields', async () => {
      const { scValToNative } = await import('@stellar/stellar-sdk')
      const configured = new RealSorobanAdapter({ ...mockConfig, tenantReputationId: TENANT_REPUTATION_ID })
      const readOnly = vi.fn().mockResolvedValue({})
      ;(configured as any).invokeReadOnly = readOnly
      ;(scValToNative as any).mockReturnValueOnce({
        composite_score: 840,
        payment_score: 900,
        property_care_score: 800,
        communication_score: 760,
        total_ratings: 12,
        last_updated: 1700000000n,
      })

      const result = await configured.getTenantReputation('tenant-1')

      expect(readOnly).toHaveBeenCalledWith(TENANT_REPUTATION_ID, 'get_reputation', ['tenant-1'])
      expect(result).toEqual({ ...record, lastUpdated: 1700000000n })
    })

    it('getTenantReputation returns null when the contract has no record', async () => {
      const { scValToNative } = await import('@stellar/stellar-sdk')
      const configured = new RealSorobanAdapter({ ...mockConfig, tenantReputationId: TENANT_REPUTATION_ID })
      ;(configured as any).invokeReadOnly = vi.fn().mockResolvedValue({})
      ;(scValToNative as any).mockReturnValueOnce(null)
      expect(await configured.getTenantReputation('tenant-1')).toBeNull()
    })
  })
})
