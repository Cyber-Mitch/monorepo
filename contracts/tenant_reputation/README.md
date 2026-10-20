# tenant_reputation

Portable, tamper-evident tenant reputation. The platform writes a tenant's scores on-chain so a good-paying tenant can prove their record to the next landlord.

The backend sends these updates from the outbox (`TxType.TENANT_REPUTATION_UPDATE`, `sendTenantReputationUpdate`). The Soroban binding that calls this contract is tracked separately (#1910).

## Record layout

`ReputationRecord` field names and order mirror `TenantReputationRecord` in `backend/src/soroban/adapter.ts`. Field names are snake_case on-chain.

| # | On-chain field           | Backend field          | Type  |
|---|--------------------------|------------------------|-------|
| 1 | `composite_score`        | `compositeScore`       | `u32` |
| 2 | `payment_score`          | `paymentScore`         | `u32` |
| 3 | `property_care_score`    | `propertyCareScore`    | `u32` |
| 4 | `communication_score`    | `communicationScore`   | `u32` |
| 5 | `total_ratings`          | `totalRatings`         | `u32` |
| 6 | `last_updated`           | `lastUpdated`          | `u64` (ledger timestamp, set on write) |

`last_updated` is set by the contract from the ledger timestamp. Callers do not supply it.

## Functions

| Function | Caller | Notes |
|----------|--------|-------|
| `init(admin, operator)` | admin (auth required) | One-time. Fails with `AlreadyInitialized` on a second call. |
| `update_reputation(operator, tenant, composite_score, payment_score, property_care_score, communication_score, total_ratings)` | admin or operator | Each score must be within the configured bounds. `total_ratings` may not decrease. Blocked while paused. |
| `get_reputation(tenant) -> Option<ReputationRecord>` | anyone | |
| `has_reputation(tenant) -> bool` | anyone | |
| `revoke_reputation(admin, tenant)` | admin | For erasure and dispute outcomes. Fails with `ReputationNotFound` if there is no record. Blocked while paused. |
| `set_score_bounds(admin, min, max)` | admin | Inclusive bounds applied to all four scores. Defaults to `0..=100`. `min` must not exceed `max`. |
| `set_operator(admin, operator)` | admin | |
| `pause(admin)` / `unpause(admin)` / `is_paused()` | admin / anyone | `Pausable`. |

## Events

| Topics | Data | Emitted by |
|--------|------|------------|
| `("tenant_reputation", "init")` | `(admin, operator)` | `init` |
| `("tenant_reputation", "updated")` | `(tenant, composite_score, total_ratings)` | `update_reputation` |
| `("tenant_reputation", "revoked")` | `tenant` | `revoke_reputation` |
| `("tenant_reputation", "bounds")` | `(min, max)` | `set_score_bounds` |
| `("tenant_reputation", "operator")` | `operator` | `set_operator` |
| `("Pausable", "pause")` / `("Pausable", "unpause")` | `()` | `pause` / `unpause` |

## Pause behaviour

While paused, every write is rejected with `Paused`: `update_reputation`, `revoke_reputation`, `set_score_bounds`, and `set_operator`. `pause`, `unpause`, and reads still work, so the admin can always unpause.

## Storage

Reputation records are persistent entries keyed by tenant address, and their TTL is extended on each write. Config (admin, operator, bounds, paused flag) lives in instance storage.
