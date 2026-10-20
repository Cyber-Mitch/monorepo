import {
    NgnWallet,
    LedgerEntry,
    NgnWalletStore,
} from './ngnWallet.js'
import { getPool } from '../db.js'
import crypto from 'crypto'

export class InMemoryNgnWalletStore implements NgnWalletStore {
    private wallets: Map<string, NgnWallet> = new Map()
    private ledger: LedgerEntry[] = []
    private locks: Map<string, Promise<void>> = new Map()
    private walletCreationByUser: Map<string, Promise<NgnWallet>> = new Map()

    async createWallet(userId: string): Promise<NgnWallet> {
        const existing = await this.getWalletByUserId(userId)
        if (existing) return existing

        const inflight = this.walletCreationByUser.get(userId)
        if (inflight) {
            return inflight
        }

        const creation = (async () => {
            const again = await this.getWalletByUserId(userId)
            if (again) return again

            const wallet: NgnWallet = {
                walletId: crypto.randomUUID(),
                userId,
                currency: 'NGN',
                createdAt: new Date(),
            }
            this.wallets.set(wallet.walletId, wallet)
            return wallet
        })()

        this.walletCreationByUser.set(userId, creation)
        try {
            return await creation
        } finally {
            this.walletCreationByUser.delete(userId)
        }
    }

    async getWalletByUserId(userId: string): Promise<NgnWallet | null> {
        return Array.from(this.wallets.values()).find(w => w.userId === userId) || null
    }

    async getWalletById(walletId: string): Promise<NgnWallet | null> {
        return this.wallets.get(walletId) || null
    }

    async createLedgerEntry(entry: Omit<LedgerEntry, 'entryId' | 'createdAt'>): Promise<LedgerEntry> {
        const newEntry: LedgerEntry = {
            ...entry,
            entryId: crypto.randomUUID(),
            createdAt: new Date(),
        }
        this.ledger.push(newEntry)
        return newEntry
    }

    async getLedgerEntriesByWalletId(walletId: string): Promise<LedgerEntry[]> {
        return this.ledger.filter((e) => e.walletId === walletId)
    }

    async listLedgerEntriesByReferenceType(referenceType: string): Promise<LedgerEntry[]> {
        return this.ledger.filter((e) => e.referenceType === referenceType)
    }

    async listWallets(options?: { limit?: number; cursor?: string }): Promise<{ items: NgnWallet[]; nextCursor: string | null }> {
        const limit = options?.limit ?? 50
        const cursor = options?.cursor
        let wallets = Array.from(this.wallets.values())
        wallets.sort((a, b) => a.userId.localeCompare(b.userId))
        if (cursor) {
            wallets = wallets.filter((w) => w.userId > cursor)
        }
        const result = wallets.slice(0, limit)
        const nextCursor = result.length === limit ? result[result.length - 1].userId : null
        return { items: result, nextCursor }
    }

    async acquireLock(walletId: string): Promise<() => Promise<void>> {
        const existingLock = this.locks.get(walletId) || Promise.resolve()
        let release: () => void = () => { }
        const newLock = new Promise<void>((resolve) => {
            release = resolve
        })
        this.locks.set(walletId, existingLock.then(() => newLock))
        await existingLock
        return async () => {
            release()
        }
    }

    async clear(): Promise<void> {
        this.wallets.clear()
        this.ledger = []
        this.locks.clear()
        this.walletCreationByUser.clear()
    }
}

export class PostgresNgnWalletStore implements NgnWalletStore {
    async createWallet(userId: string): Promise<NgnWallet> {
        const pool = await getPool()
        if (!pool) throw new Error('Database pool not available')
        const { rows } = await pool.query(
            `INSERT INTO ngn_wallets (user_id) 
       VALUES ($1) 
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id 
       RETURNING *`,
            [userId]
        )
        return this.mapWallet(rows[0])
    }

    async getWalletByUserId(userId: string): Promise<NgnWallet | null> {
        const pool = await getPool()
        if (!pool) return null
        const { rows } = await pool.query(
            `SELECT * FROM ngn_wallets WHERE user_id = $1`,
            [userId]
        )
        return rows[0] ? this.mapWallet(rows[0]) : null
    }

    async getWalletById(walletId: string): Promise<NgnWallet | null> {
        const pool = await getPool()
        if (!pool) return null
        const { rows } = await pool.query(
            `SELECT * FROM ngn_wallets WHERE wallet_id = $1`,
            [walletId]
        )
        return rows[0] ? this.mapWallet(rows[0]) : null
    }

    async createLedgerEntry(entry: Omit<LedgerEntry, 'entryId' | 'createdAt'>): Promise<LedgerEntry> {
        const pool = await getPool()
        if (!pool) throw new Error('Database pool not available')
        const { rows } = await pool.query(
            `INSERT INTO ngn_ledger_entries (wallet_id, type, amount_ngn, reference_type, reference_id) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
            [entry.walletId, entry.type, entry.amountNgn, entry.referenceType, entry.referenceId]
        )
        return this.mapLedgerEntry(rows[0])
    }

    async getLedgerEntriesByWalletId(walletId: string): Promise<LedgerEntry[]> {
        const pool = await getPool()
        if (!pool) return []
        const { rows } = await pool.query(`SELECT * FROM ngn_ledger_entries WHERE wallet_id=$1 ORDER BY created_at DESC`, [walletId])
        return rows.map(this.mapLedgerEntry)
    }

    async listLedgerEntriesByReferenceType(referenceType: string): Promise<LedgerEntry[]> {
        const pool = await getPool()
        if (!pool) return []
        const { rows } = await pool.query(
            `SELECT * FROM ngn_ledger_entries WHERE reference_type = $1 ORDER BY created_at ASC`,
            [referenceType]
        )
        return rows.map(this.mapLedgerEntry)
    }

    async listWallets(options?: { limit?: number; cursor?: string }): Promise<{ items: NgnWallet[]; nextCursor: string | null }> {
        const pool = await getPool()
        if (!pool) return { items: [], nextCursor: null } // We don't list from fallback cache in listWallets for simplicity or return some dummy

        const limit = options?.limit ?? 50
        const cursor = options?.cursor
        const params: any[] = [limit]
        let where = ''
        if (cursor) {
            params.push(cursor)
            where = 'WHERE user_id > $2'
        }

        const { rows } = await pool.query(
            `SELECT * FROM ngn_wallets ${where} ORDER BY user_id ASC LIMIT $1`,
            params
        )
        const items = rows.map(this.mapWallet)
        const nextCursor = items.length === limit ? items[items.length - 1].userId : null
        return { items, nextCursor }
    }

    async acquireLock(walletId: string): Promise<() => Promise<void>> {
        const pool = await getPool()
        if (!pool) throw new Error('Database pool not available')
        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            // Row level lock
            await client.query('SELECT 1 FROM ngn_wallets WHERE wallet_id = $1 FOR UPDATE', [walletId])
            return async () => {
                await client.query('COMMIT')
                client.release()
            }
        } catch (e) {
            await client.query('ROLLBACK')
            client.release()
            throw e
        }
    }

    async clear(): Promise<void> {
        const pool = await getPool()
        if (!pool) return
        await pool.query('DELETE FROM ngn_ledger_entries')
        await pool.query('DELETE FROM ngn_wallets')
    }

    private mapWallet(row: any): NgnWallet {
        return {
            walletId: row.wallet_id,
            userId: row.user_id,
            currency: row.currency,
            createdAt: new Date(row.created_at)
        }
    }

    private mapLedgerEntry(row: any): LedgerEntry {
        return {
            entryId: row.entry_id,
            walletId: row.wallet_id,
            type: row.type,
            amountNgn: Number(row.amount_ngn),
            referenceType: row.reference_type,
            referenceId: row.reference_id,
            createdAt: new Date(row.created_at)
        }
    }
}

/**
 * The store the app uses. It forwards to one implementation, in memory by default, and
 * `initNgnWalletStore` swaps in Postgres at startup, as the other `init*Store()` functions do.
 */
class SwitchableNgnWalletStore implements NgnWalletStore {
    private impl: NgnWalletStore = new InMemoryNgnWalletStore()
    use(impl: NgnWalletStore) { this.impl = impl }
    createWallet(userId: string) { return this.impl.createWallet(userId) }
    getWalletByUserId(userId: string) { return this.impl.getWalletByUserId(userId) }
    getWalletById(walletId: string) { return this.impl.getWalletById(walletId) }
    createLedgerEntry(entry: Omit<LedgerEntry, 'entryId' | 'createdAt'>) { return this.impl.createLedgerEntry(entry) }
    getLedgerEntriesByWalletId(walletId: string) { return this.impl.getLedgerEntriesByWalletId(walletId) }
    listLedgerEntriesByReferenceType(referenceType: string) { return this.impl.listLedgerEntriesByReferenceType(referenceType) }
    listWallets(options?: { limit?: number; cursor?: string }) { return this.impl.listWallets(options) }
    acquireLock(walletId: string) { return this.impl.acquireLock(walletId) }
    clear() { return this.impl.clear() }
}

const switchableNgnWalletStore = new SwitchableNgnWalletStore()
export const ngnWalletStore: NgnWalletStore = switchableNgnWalletStore

export function initNgnWalletStore(impl: NgnWalletStore): void {
    switchableNgnWalletStore.use(impl)
}
