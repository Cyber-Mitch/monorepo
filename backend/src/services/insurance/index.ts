import { AppError } from '../../errors/AppError.js'
import { ErrorCode } from '../../errors/errorCodes.js'
import { env } from '../../schemas/env.js'
import { MockRentGuaranteeProvider } from './mockProvider.js'
import type { RentGuaranteeProvider } from './types.js'

export * from './types.js'
export { MockRentGuaranteeProvider } from './mockProvider.js'

/**
 * Placeholder for insurers we have not integrated with yet. Every operation
 * fails loudly rather than pretending to cover anyone.
 */
export class UnconfiguredRentGuaranteeProvider implements RentGuaranteeProvider {
  constructor(readonly name: string) {}

  private fail(): never {
    throw new AppError(
      ErrorCode.NOT_IMPLEMENTED,
      501,
      `Rent guarantee provider "${this.name}" is not configured`,
    )
  }

  async quote(): Promise<never> {
    return this.fail()
  }
  async bind(): Promise<never> {
    return this.fail()
  }
  async cancel(): Promise<never> {
    return this.fail()
  }
  async fileClaim(): Promise<never> {
    return this.fail()
  }
}

export type RentGuaranteeProviderName = 'mock' | 'leatherback' | 'heirs'

export function createRentGuaranteeProvider(
  name: RentGuaranteeProviderName = env.RENT_GUARANTEE_PROVIDER,
): RentGuaranteeProvider {
  switch (name) {
    case 'mock':
      return new MockRentGuaranteeProvider()
    case 'leatherback':
    case 'heirs':
      return new UnconfiguredRentGuaranteeProvider(name)
  }
}
