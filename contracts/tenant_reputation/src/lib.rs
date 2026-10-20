#![no_std]

use soroban_access_control::{
    extend_storage_ttl, require_admin_or_operator_permission, require_admin_permission,
};
use soroban_pausable::{Pausable, PausableError};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, IntoVal, Symbol,
};

/// Inclusive score bounds used until `set_score_bounds` is called.
const DEFAULT_MIN_SCORE: u32 = 0;
const DEFAULT_MAX_SCORE: u32 = 100;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Operator,
    Paused,
    ScoreBounds,
    Reputation(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreBounds {
    pub min: u32,
    pub max: u32,
}

/// Tenant reputation as stored on-chain.
///
/// Field names and order mirror `TenantReputationRecord` in
/// `backend/src/soroban/adapter.ts` (snake_case on-chain). See the crate README.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationRecord {
    pub composite_score: u32,
    pub payment_score: u32,
    pub property_care_score: u32,
    pub communication_score: u32,
    pub total_ratings: u32,
    pub last_updated: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAuthorized = 3,
    Paused = 4,
    InvalidScore = 5,
    InvalidBounds = 6,
    TotalRatingsDecreased = 7,
    ReputationNotFound = 8,
}

#[contract]
pub struct TenantReputation;

fn get_admin(env: &Env) -> Result<Address, ContractError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ContractError::NotInitialized)
}

fn get_operator(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Operator)
}

fn get_bounds(env: &Env) -> ScoreBounds {
    env.storage()
        .instance()
        .get(&DataKey::ScoreBounds)
        .unwrap_or(ScoreBounds {
            min: DEFAULT_MIN_SCORE,
            max: DEFAULT_MAX_SCORE,
        })
}

fn read_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn require_not_paused(env: &Env) -> Result<(), ContractError> {
    if read_paused(env) {
        return Err(ContractError::Paused);
    }
    Ok(())
}

fn require_score_in_bounds(bounds: &ScoreBounds, score: u32) -> Result<(), ContractError> {
    if score < bounds.min || score > bounds.max {
        return Err(ContractError::InvalidScore);
    }
    Ok(())
}

#[contractimpl]
impl TenantReputation {
    /// One-time setup. The admin must authorise, so a third party cannot
    /// front-run initialisation and install themselves as admin.
    pub fn init(env: Env, admin: Address, operator: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Operator, &operator);
        env.events().publish(
            (
                Symbol::new(&env, "tenant_reputation"),
                Symbol::new(&env, "init"),
            ),
            (admin, operator),
        );
        Ok(())
    }

    /// Write a tenant's reputation. Callable by the admin or the configured operator.
    ///
    /// `operator` is the caller; it may be either the admin or the operator set
    /// at init or via `set_operator`. Each score must sit within the configured
    /// bounds, and `total_ratings` may never decrease for an existing record.
    #[allow(clippy::too_many_arguments)]
    pub fn update_reputation(
        env: Env,
        operator: Address,
        tenant: Address,
        composite_score: u32,
        payment_score: u32,
        property_care_score: u32,
        communication_score: u32,
        total_ratings: u32,
    ) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        require_admin_or_operator_permission(
            &env,
            &admin,
            get_operator(&env).as_ref(),
            &operator,
            "update_reputation",
            ContractError::NotAuthorized,
        )?;
        require_not_paused(&env)?;

        let bounds = get_bounds(&env);
        for score in [
            composite_score,
            payment_score,
            property_care_score,
            communication_score,
        ] {
            require_score_in_bounds(&bounds, score)?;
        }

        let key = DataKey::Reputation(tenant.clone());
        if let Some(existing) = env.storage().persistent().get::<_, ReputationRecord>(&key) {
            if total_ratings < existing.total_ratings {
                return Err(ContractError::TotalRatingsDecreased);
            }
        }

        let record = ReputationRecord {
            composite_score,
            payment_score,
            property_care_score,
            communication_score,
            total_ratings,
            last_updated: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &record);
        extend_storage_ttl(&env, &key.into_val(&env));

        env.events().publish(
            (
                Symbol::new(&env, "tenant_reputation"),
                Symbol::new(&env, "updated"),
            ),
            (tenant, composite_score, total_ratings),
        );
        Ok(())
    }

    /// Remove a tenant's reputation, e.g. after an erasure request or a dispute outcome.
    pub fn revoke_reputation(
        env: Env,
        admin: Address,
        tenant: Address,
    ) -> Result<(), ContractError> {
        let current_admin = get_admin(&env)?;
        require_admin_permission(
            &env,
            &current_admin,
            &admin,
            "revoke_reputation",
            ContractError::NotAuthorized,
        )?;
        require_not_paused(&env)?;

        let key = DataKey::Reputation(tenant.clone());
        if !env.storage().persistent().has(&key) {
            return Err(ContractError::ReputationNotFound);
        }
        env.storage().persistent().remove(&key);

        env.events().publish(
            (
                Symbol::new(&env, "tenant_reputation"),
                Symbol::new(&env, "revoked"),
            ),
            tenant,
        );
        Ok(())
    }

    pub fn get_reputation(env: Env, tenant: Address) -> Option<ReputationRecord> {
        env.storage().persistent().get(&DataKey::Reputation(tenant))
    }

    pub fn has_reputation(env: Env, tenant: Address) -> bool {
        env.storage().persistent().has(&DataKey::Reputation(tenant))
    }

    /// Set the inclusive score bounds. Admin only.
    pub fn set_score_bounds(
        env: Env,
        admin: Address,
        min: u32,
        max: u32,
    ) -> Result<(), ContractError> {
        let current_admin = get_admin(&env)?;
        require_admin_permission(
            &env,
            &current_admin,
            &admin,
            "set_score_bounds",
            ContractError::NotAuthorized,
        )?;
        require_not_paused(&env)?;
        if min > max {
            return Err(ContractError::InvalidBounds);
        }

        env.storage()
            .instance()
            .set(&DataKey::ScoreBounds, &ScoreBounds { min, max });
        env.events().publish(
            (
                Symbol::new(&env, "tenant_reputation"),
                Symbol::new(&env, "bounds"),
            ),
            (min, max),
        );
        Ok(())
    }

    /// Replace the operator. Admin only.
    pub fn set_operator(env: Env, admin: Address, operator: Address) -> Result<(), ContractError> {
        let current_admin = get_admin(&env)?;
        require_admin_permission(
            &env,
            &current_admin,
            &admin,
            "set_operator",
            ContractError::NotAuthorized,
        )?;
        require_not_paused(&env)?;

        env.storage().instance().set(&DataKey::Operator, &operator);
        env.events().publish(
            (
                Symbol::new(&env, "tenant_reputation"),
                Symbol::new(&env, "operator"),
            ),
            operator,
        );
        Ok(())
    }
}

#[contractimpl]
impl Pausable for TenantReputation {
    fn pause(env: Env, admin: Address) -> Result<(), PausableError> {
        let current_admin = get_admin(&env).map_err(|_| PausableError::NotAuthorized)?;
        require_admin_permission(
            &env,
            &current_admin,
            &admin,
            "pause",
            ContractError::NotAuthorized,
        )
        .map_err(|_| PausableError::NotAuthorized)?;

        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish(
            (Symbol::new(&env, "Pausable"), Symbol::new(&env, "pause")),
            (),
        );
        Ok(())
    }

    fn unpause(env: Env, admin: Address) -> Result<(), PausableError> {
        let current_admin = get_admin(&env).map_err(|_| PausableError::NotAuthorized)?;
        require_admin_permission(
            &env,
            &current_admin,
            &admin,
            "unpause",
            ContractError::NotAuthorized,
        )
        .map_err(|_| PausableError::NotAuthorized)?;

        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (Symbol::new(&env, "Pausable"), Symbol::new(&env, "unpause")),
            (),
        );
        Ok(())
    }

    fn is_paused(env: Env) -> bool {
        read_paused(&env)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Env};

    struct Setup<'a> {
        env: Env,
        client: TenantReputationClient<'a>,
        admin: Address,
        operator: Address,
        tenant: Address,
    }

    fn setup<'a>() -> Setup<'a> {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(TenantReputation, ());
        let client = TenantReputationClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let operator = Address::generate(&env);
        let tenant = Address::generate(&env);
        client.try_init(&admin, &operator).unwrap().unwrap();

        Setup {
            env,
            client,
            admin,
            operator,
            tenant,
        }
    }

    #[test]
    fn admin_and_operator_can_update() {
        let s = setup();
        s.env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);

        s.client
            .try_update_reputation(&s.admin, &s.tenant, &80, &90, &70, &85, &10)
            .unwrap()
            .unwrap();
        assert!(s.client.has_reputation(&s.tenant));

        let record = s.client.get_reputation(&s.tenant).unwrap();
        assert_eq!(record.composite_score, 80);
        assert_eq!(record.payment_score, 90);
        assert_eq!(record.property_care_score, 70);
        assert_eq!(record.communication_score, 85);
        assert_eq!(record.total_ratings, 10);
        assert_eq!(record.last_updated, 1_700_000_000);

        s.client
            .try_update_reputation(&s.operator, &s.tenant, &82, &90, &70, &85, &11)
            .unwrap()
            .unwrap();
        assert_eq!(
            s.client.get_reputation(&s.tenant).unwrap().composite_score,
            82
        );
    }

    #[test]
    fn stranger_cannot_update() {
        let s = setup();
        let stranger = Address::generate(&s.env);

        assert!(matches!(
            s.client
                .try_update_reputation(&stranger, &s.tenant, &50, &50, &50, &50, &1),
            Err(Ok(ContractError::NotAuthorized))
        ));
        assert!(!s.client.has_reputation(&s.tenant));
    }

    #[test]
    fn out_of_bounds_scores_rejected() {
        let s = setup();

        assert!(matches!(
            s.client
                .try_update_reputation(&s.admin, &s.tenant, &101, &50, &50, &50, &1),
            Err(Ok(ContractError::InvalidScore))
        ));
        s.client
            .try_update_reputation(&s.admin, &s.tenant, &100, &0, &50, &50, &1)
            .unwrap()
            .unwrap();
    }

    #[test]
    fn configured_bounds_are_enforced() {
        let s = setup();
        s.client
            .try_set_score_bounds(&s.admin, &10, &20)
            .unwrap()
            .unwrap();

        assert!(matches!(
            s.client
                .try_update_reputation(&s.admin, &s.tenant, &5, &15, &15, &15, &1),
            Err(Ok(ContractError::InvalidScore))
        ));
        s.client
            .try_update_reputation(&s.admin, &s.tenant, &10, &15, &15, &20, &1)
            .unwrap()
            .unwrap();
    }

    #[test]
    fn invalid_bounds_rejected() {
        let s = setup();

        assert!(matches!(
            s.client.try_set_score_bounds(&s.admin, &30, &20),
            Err(Ok(ContractError::InvalidBounds))
        ));
    }

    #[test]
    fn total_ratings_cannot_decrease() {
        let s = setup();
        s.client
            .try_update_reputation(&s.admin, &s.tenant, &50, &50, &50, &50, &5)
            .unwrap()
            .unwrap();

        assert!(matches!(
            s.client
                .try_update_reputation(&s.admin, &s.tenant, &50, &50, &50, &50, &4),
            Err(Ok(ContractError::TotalRatingsDecreased))
        ));
        s.client
            .try_update_reputation(&s.admin, &s.tenant, &50, &50, &50, &50, &5)
            .unwrap()
            .unwrap();
    }

    #[test]
    fn revoke_removes_record() {
        let s = setup();
        s.client
            .try_update_reputation(&s.admin, &s.tenant, &50, &50, &50, &50, &1)
            .unwrap()
            .unwrap();

        s.client
            .try_revoke_reputation(&s.admin, &s.tenant)
            .unwrap()
            .unwrap();
        assert!(!s.client.has_reputation(&s.tenant));
        assert!(s.client.get_reputation(&s.tenant).is_none());

        assert!(matches!(
            s.client.try_revoke_reputation(&s.admin, &s.tenant),
            Err(Ok(ContractError::ReputationNotFound))
        ));
    }

    #[test]
    fn only_admin_can_revoke() {
        let s = setup();
        s.client
            .try_update_reputation(&s.admin, &s.tenant, &50, &50, &50, &50, &1)
            .unwrap()
            .unwrap();

        assert!(matches!(
            s.client.try_revoke_reputation(&s.operator, &s.tenant),
            Err(Ok(ContractError::NotAuthorized))
        ));
        assert!(s.client.has_reputation(&s.tenant));
    }

    #[test]
    fn pause_blocks_writes() {
        let s = setup();
        s.client.try_pause(&s.admin).unwrap().unwrap();
        assert!(s.client.is_paused());

        assert!(matches!(
            s.client
                .try_update_reputation(&s.admin, &s.tenant, &50, &50, &50, &50, &1),
            Err(Ok(ContractError::Paused))
        ));
        assert!(matches!(
            s.client.try_revoke_reputation(&s.admin, &s.tenant),
            Err(Ok(ContractError::Paused))
        ));

        s.client.try_unpause(&s.admin).unwrap().unwrap();
        assert!(!s.client.is_paused());
        s.client
            .try_update_reputation(&s.admin, &s.tenant, &50, &50, &50, &50, &1)
            .unwrap()
            .unwrap();
    }

    #[test]
    fn events_emitted_on_update_and_revoke() {
        use soroban_sdk::testutils::Events;

        let s = setup();
        s.client
            .try_update_reputation(&s.admin, &s.tenant, &50, &50, &50, &50, &1)
            .unwrap()
            .unwrap();
        assert!(!s.env.events().all().is_empty());

        s.client
            .try_revoke_reputation(&s.admin, &s.tenant)
            .unwrap()
            .unwrap();
        assert!(!s.env.events().all().is_empty());
    }
}
