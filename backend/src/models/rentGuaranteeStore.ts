/**
 * Rent guarantee policy and claim store (#1908).
 * Status changes are compare-and-set so concurrent requests cannot both win.
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../db.js";

export type RentGuaranteePolicyStatus =
  | "quoted"
  | "active"
  | "cancelled"
  | "claimed";

/** Allowed status transitions; anything else is rejected. */
export const POLICY_TRANSITIONS: Record<
  RentGuaranteePolicyStatus,
  RentGuaranteePolicyStatus[]
> = {
  quoted: ["active", "cancelled"],
  active: ["cancelled", "claimed"],
  cancelled: [],
  claimed: [],
};

export function canTransitionPolicy(
  from: RentGuaranteePolicyStatus,
  to: RentGuaranteePolicyStatus,
): boolean {
  return POLICY_TRANSITIONS[from].includes(to);
}

export interface RentGuaranteePolicy {
  id: string;
  dealId: string;
  landlordId: string;
  provider: string;
  policyNumber: string;
  premiumNgn: number;
  coverageTermMonths: number;
  status: RentGuaranteePolicyStatus;
  providerReference: string | null;
  activatedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRentGuaranteePolicyData {
  dealId: string;
  landlordId: string;
  provider: string;
  policyNumber: string;
  premiumNgn: number;
  coverageTermMonths: number;
}

export interface RentGuaranteeClaim {
  id: string;
  policyId: string;
  landlordId: string;
  amountNgn: number;
  reason: string;
  status: "submitted" | "approved" | "rejected" | "paid";
  providerReference: string | null;
  createdAt: Date;
}

export interface CreateRentGuaranteeClaimData {
  amountNgn: number;
  reason: string;
  providerReference: string;
}

export interface PolicyTransitionPatch {
  providerReference?: string;
  cancellationReason?: string;
}

export interface RentGuaranteeStore {
  createPolicy(data: CreateRentGuaranteePolicyData): Promise<RentGuaranteePolicy>;
  findPolicyById(id: string): Promise<RentGuaranteePolicy | null>;
  /** Latest policy for the deal that is still quoted or active. */
  findOpenPolicyForDeal(dealId: string): Promise<RentGuaranteePolicy | null>;
  countPoliciesForDeal(dealId: string): Promise<number>;
  listPoliciesByLandlord(landlordId: string): Promise<RentGuaranteePolicy[]>;
  /** Moves the policy to `to` only if it is currently in `from`; null when it is not. */
  transitionPolicy(
    id: string,
    from: RentGuaranteePolicyStatus,
    to: Exclude<RentGuaranteePolicyStatus, "quoted">,
    patch?: PolicyTransitionPatch,
  ): Promise<RentGuaranteePolicy | null>;
  /** Atomically marks an active policy claimed and records the claim; null if not active. */
  fileClaim(
    policyId: string,
    data: CreateRentGuaranteeClaimData,
  ): Promise<{ policy: RentGuaranteePolicy; claim: RentGuaranteeClaim } | null>;
  listClaims(policyId: string): Promise<RentGuaranteeClaim[]>;
  clear(): Promise<void>;
}

export class InMemoryRentGuaranteeStore implements RentGuaranteeStore {
  private policies = new Map<string, RentGuaranteePolicy>();
  private claims = new Map<string, RentGuaranteeClaim>();

  async createPolicy(
    data: CreateRentGuaranteePolicyData,
  ): Promise<RentGuaranteePolicy> {
    for (const p of this.policies.values()) {
      if (p.policyNumber === data.policyNumber) {
        throw new Error(`Duplicate policy number ${data.policyNumber}`);
      }
    }
    const now = new Date();
    const policy: RentGuaranteePolicy = {
      id: randomUUID(),
      ...data,
      status: "quoted",
      providerReference: null,
      activatedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.policies.set(policy.id, policy);
    return policy;
  }

  async findPolicyById(id: string): Promise<RentGuaranteePolicy | null> {
    return this.policies.get(id) ?? null;
  }

  async findOpenPolicyForDeal(
    dealId: string,
  ): Promise<RentGuaranteePolicy | null> {
    const open = [...this.policies.values()]
      .filter(
        (p) =>
          p.dealId === dealId && (p.status === "quoted" || p.status === "active"),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return open[0] ?? null;
  }

  async countPoliciesForDeal(dealId: string): Promise<number> {
    return [...this.policies.values()].filter((p) => p.dealId === dealId).length;
  }

  async listPoliciesByLandlord(
    landlordId: string,
  ): Promise<RentGuaranteePolicy[]> {
    return [...this.policies.values()]
      .filter((p) => p.landlordId === landlordId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async transitionPolicy(
    id: string,
    from: RentGuaranteePolicyStatus,
    to: Exclude<RentGuaranteePolicyStatus, "quoted">,
    patch: PolicyTransitionPatch = {},
  ): Promise<RentGuaranteePolicy | null> {
    const policy = this.policies.get(id);
    if (!policy || policy.status !== from) return null;
    const now = new Date();
    const updated: RentGuaranteePolicy = {
      ...policy,
      status: to,
      providerReference: patch.providerReference ?? policy.providerReference,
      activatedAt: to === "active" ? now : policy.activatedAt,
      cancelledAt: to === "cancelled" ? now : policy.cancelledAt,
      cancellationReason: patch.cancellationReason ?? policy.cancellationReason,
      updatedAt: now,
    };
    this.policies.set(id, updated);
    return updated;
  }

  async fileClaim(
    policyId: string,
    data: CreateRentGuaranteeClaimData,
  ): Promise<{ policy: RentGuaranteePolicy; claim: RentGuaranteeClaim } | null> {
    const policy = await this.transitionPolicy(policyId, "active", "claimed");
    if (!policy) return null;
    const claim: RentGuaranteeClaim = {
      id: randomUUID(),
      policyId,
      landlordId: policy.landlordId,
      amountNgn: data.amountNgn,
      reason: data.reason,
      status: "submitted",
      providerReference: data.providerReference,
      createdAt: new Date(),
    };
    this.claims.set(claim.id, claim);
    return { policy, claim };
  }

  async listClaims(policyId: string): Promise<RentGuaranteeClaim[]> {
    return [...this.claims.values()]
      .filter((c) => c.policyId === policyId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async clear(): Promise<void> {
    this.policies.clear();
    this.claims.clear();
  }
}

type PolicyRow = {
  id: string;
  deal_id: string;
  landlord_id: string;
  provider: string;
  policy_number: string;
  premium_ngn: string;
  coverage_term_months: number;
  status: RentGuaranteePolicyStatus;
  provider_reference: string | null;
  activated_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

type ClaimRow = {
  id: string;
  policy_id: string;
  landlord_id: string;
  amount_ngn: string;
  reason: string;
  status: RentGuaranteeClaim["status"];
  provider_reference: string | null;
  created_at: Date;
};

const POLICY_COLUMNS = `id, deal_id, landlord_id, provider, policy_number, premium_ngn,
  coverage_term_months, status, provider_reference, activated_at, cancelled_at,
  cancellation_reason, created_at, updated_at`;

function mapPolicy(row: PolicyRow): RentGuaranteePolicy {
  return {
    id: row.id,
    dealId: row.deal_id,
    landlordId: row.landlord_id,
    provider: row.provider,
    policyNumber: row.policy_number,
    premiumNgn: Number(row.premium_ngn),
    coverageTermMonths: row.coverage_term_months,
    status: row.status,
    providerReference: row.provider_reference,
    activatedAt: row.activated_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClaim(row: ClaimRow): RentGuaranteeClaim {
  return {
    id: row.id,
    policyId: row.policy_id,
    landlordId: row.landlord_id,
    amountNgn: Number(row.amount_ngn),
    reason: row.reason,
    status: row.status,
    providerReference: row.provider_reference,
    createdAt: row.created_at,
  };
}

export class PostgresRentGuaranteeStore implements RentGuaranteeStore {
  private async pool() {
    const pool = await getPool();
    if (!pool) throw new Error("Database pool not initialized");
    return pool;
  }

  async createPolicy(
    data: CreateRentGuaranteePolicyData,
  ): Promise<RentGuaranteePolicy> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `INSERT INTO rent_guarantee_policies
         (deal_id, landlord_id, provider, policy_number, premium_ngn, coverage_term_months)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${POLICY_COLUMNS}`,
      [
        data.dealId,
        data.landlordId,
        data.provider,
        data.policyNumber,
        data.premiumNgn,
        data.coverageTermMonths,
      ],
    );
    return mapPolicy(rows[0] as PolicyRow);
  }

  async findPolicyById(id: string): Promise<RentGuaranteePolicy | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT ${POLICY_COLUMNS} FROM rent_guarantee_policies WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapPolicy(rows[0] as PolicyRow) : null;
  }

  async findOpenPolicyForDeal(
    dealId: string,
  ): Promise<RentGuaranteePolicy | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT ${POLICY_COLUMNS} FROM rent_guarantee_policies
       WHERE deal_id = $1 AND status IN ('quoted', 'active')
       ORDER BY created_at DESC LIMIT 1`,
      [dealId],
    );
    return rows[0] ? mapPolicy(rows[0] as PolicyRow) : null;
  }

  async countPoliciesForDeal(dealId: string): Promise<number> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM rent_guarantee_policies WHERE deal_id = $1`,
      [dealId],
    );
    return rows[0]?.total ?? 0;
  }

  async listPoliciesByLandlord(
    landlordId: string,
  ): Promise<RentGuaranteePolicy[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT ${POLICY_COLUMNS} FROM rent_guarantee_policies
       WHERE landlord_id = $1 ORDER BY created_at DESC`,
      [landlordId],
    );
    return rows.map((r: unknown) => mapPolicy(r as PolicyRow));
  }

  async transitionPolicy(
    id: string,
    from: RentGuaranteePolicyStatus,
    to: Exclude<RentGuaranteePolicyStatus, "quoted">,
    patch: PolicyTransitionPatch = {},
  ): Promise<RentGuaranteePolicy | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `UPDATE rent_guarantee_policies
       SET status = $3,
           provider_reference = COALESCE($4, provider_reference),
           cancellation_reason = COALESCE($5, cancellation_reason),
           activated_at = CASE WHEN $3 = 'active' THEN NOW() ELSE activated_at END,
           cancelled_at = CASE WHEN $3 = 'cancelled' THEN NOW() ELSE cancelled_at END,
           updated_at = NOW()
       WHERE id = $1 AND status = $2
       RETURNING ${POLICY_COLUMNS}`,
      [id, from, to, patch.providerReference ?? null, patch.cancellationReason ?? null],
    );
    return rows[0] ? mapPolicy(rows[0] as PolicyRow) : null;
  }

  async fileClaim(
    policyId: string,
    data: CreateRentGuaranteeClaimData,
  ): Promise<{ policy: RentGuaranteePolicy; claim: RentGuaranteeClaim } | null> {
    const pool = await this.pool();
    // One statement: the claim row is inserted only if the active -> claimed
    // update matched, so a policy can never be claimed twice or half-claimed.
    const { rows } = await pool.query(
      `WITH upd AS (
         UPDATE rent_guarantee_policies
         SET status = 'claimed', updated_at = NOW()
         WHERE id = $1 AND status = 'active'
         RETURNING id, landlord_id
       )
       INSERT INTO rent_guarantee_claims (policy_id, landlord_id, amount_ngn, reason, provider_reference)
       SELECT id, landlord_id, $2, $3, $4 FROM upd
       RETURNING id, policy_id, landlord_id, amount_ngn, reason, status, provider_reference, created_at`,
      [policyId, data.amountNgn, data.reason, data.providerReference],
    );
    if (!rows[0]) return null;
    const policy = await this.findPolicyById(policyId);
    if (!policy) return null;
    return { policy, claim: mapClaim(rows[0] as ClaimRow) };
  }

  async listClaims(policyId: string): Promise<RentGuaranteeClaim[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT id, policy_id, landlord_id, amount_ngn, reason, status, provider_reference, created_at
       FROM rent_guarantee_claims WHERE policy_id = $1 ORDER BY created_at DESC`,
      [policyId],
    );
    return rows.map((r: unknown) => mapClaim(r as ClaimRow));
  }

  async clear(): Promise<void> {
    const pool = await this.pool();
    await pool.query("DELETE FROM rent_guarantee_claims");
    await pool.query("DELETE FROM rent_guarantee_policies");
  }
}

let rentGuaranteeStore: RentGuaranteeStore = new InMemoryRentGuaranteeStore();

export function initRentGuaranteeStore(store: RentGuaranteeStore): void {
  rentGuaranteeStore = store;
}

export { rentGuaranteeStore };
