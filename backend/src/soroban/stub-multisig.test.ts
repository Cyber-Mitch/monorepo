import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StubMultisig } from './stub-multisig.js'

const T0 = 1_800_000_000
const WEEK = 604_800

describe('StubMultisig (#1972)', () => {
  let book: StubMultisig

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(T0 * 1000))
    book = new StubMultisig()
    book.configure({ signers: ['A', 'B', 'C'], threshold: 2 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const propose = () => book.propose('A', 'TARGET', 'do_it', [{ type: 'u32', value: 1 }])

  it('numbers proposals from 1 and starts them pending with no approvals', () => {
    expect(propose()).toBe(1)
    expect(propose()).toBe(2)
    expect(book.get(1)).toMatchObject({
      id: 1,
      proposer: 'A',
      target: 'TARGET',
      function: 'do_it',
      args: [1],
      approvals: [],
      status: 'pending',
      createdAt: T0,
      expiresAt: T0 + WEEK,
    })
  })

  it('only lets signers act', () => {
    expect(() => book.propose('X', 'T', 'f', [])).toThrow(/Not a signer/)
    propose()
    expect(() => book.approve('X', 1)).toThrow(/Not a signer/)
    expect(() => book.revokeApproval('X', 1)).toThrow(/Not a signer/)
    expect(() => book.execute('X', 1)).toThrow(/Not a signer/)
  })

  it('records each approval once', () => {
    propose()
    book.approve('A', 1)
    book.approve('B', 1)

    expect(book.get(1)?.approvals).toEqual(['A', 'B'])
    expect(() => book.approve('A', 1)).toThrow(/Already approved/)
  })

  it('executes only once the threshold is reached, and only once', () => {
    propose()
    book.approve('A', 1)
    expect(() => book.execute('C', 1)).toThrow(/threshold not reached/)

    book.approve('B', 1)
    book.execute('C', 1)

    expect(book.get(1)?.status).toBe('executed')
    expect(book.executedCalls).toHaveLength(1)
    expect(() => book.execute('C', 1)).toThrow(/not pending/)
    expect(() => book.approve('C', 1)).toThrow(/not pending/)
  })

  it('lets an approval be withdrawn, and only by its owner', () => {
    propose()
    book.approve('A', 1)
    expect(() => book.revokeApproval('B', 1)).toThrow(/Not approved/)

    book.revokeApproval('A', 1)

    expect(book.get(1)?.approvals).toEqual([])
  })

  it('treats a proposal as expired after its deadline and refuses to act on it', () => {
    propose()
    book.approve('A', 1)
    book.approve('B', 1)
    vi.setSystemTime(new Date((T0 + WEEK + 1) * 1000))

    expect(book.get(1)?.status).toBe('expired')
    expect(book.list('expired').map((p) => p.id)).toEqual([1])
    expect(book.list('pending')).toEqual([])
    expect(() => book.execute('A', 1)).toThrow(/expired/)
    expect(() => book.approve('C', 1)).toThrow(/expired/)
  })

  it('is still actionable right up to the deadline', () => {
    propose()
    vi.setSystemTime(new Date((T0 + WEEK) * 1000))

    expect(() => book.approve('A', 1)).not.toThrow()
  })

  it('returns null for an unknown proposal and 404s on acting on one', () => {
    expect(book.get(9)).toBeNull()
    expect(() => book.approve('A', 9)).toThrow(/not found/)
  })

  it('does not let callers mutate its state through returned values', () => {
    propose()
    book.get(1)!.approvals.push('Z')
    book.list()[0].args.push('junk')

    expect(book.get(1)?.approvals).toEqual([])
    expect(book.get(1)?.args).toEqual([1])
  })
})
