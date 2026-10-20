#![no_std]

use soroban_access_control::{extend_storage_ttl, require_admin_permission};
use soroban_pausable::{Pausable, PausableError};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, IntoVal,
    Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAuthorized = 3,
    Paused = 4,
    DowngradeNotAllowed = 5,
    DuplicateTransition = 6,
    UnsupportedTransition = 7,
    MigrationAlreadyExecuted = 8,
    ReceiptNotFound = 9,
}

impl From<PausableError> for Error {
    fn from(err: PausableError) -> Self {
        match err {
            PausableError::Paused => Error::Paused,
            PausableError::NotAuthorized => Error::NotAuthorized,
        }
    }
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub struct SchemaVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationReceipt {
    pub id: u32,
    pub contract: Address,
    pub from: SchemaVersion,
    pub to: SchemaVersion,
    pub executed_at: u64,
    pub executed_by: Address,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    SupportedTransition(SchemaVersion, SchemaVersion),
    MigrationReceipt(u32),
    MigrationExecuted(Address, SchemaVersion, SchemaVersion),
    ReceiptCount,
}

#[contract]
pub struct SchemaRegistry;

#[contractimpl]
impl SchemaRegistry {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);

        let count_key = DataKey::ReceiptCount;
        env.storage().persistent().set(&count_key, &0u32);
        extend_storage_ttl(&env, &count_key.into_val(&env));

        env.events().publish(
            (
                Symbol::new(&env, "schema_reg"),
                Symbol::new(&env, "initialize"),
            ),
            admin,
        );

        Ok(())
    }

    pub fn register_transition(
        env: Env,
        admin: Address,
        source: SchemaVersion,
        target: SchemaVersion,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_admin(&env, &admin)?;

        if target <= source {
            return Err(Error::DowngradeNotAllowed);
        }

        let key = DataKey::SupportedTransition(source, target);
        if env.storage().persistent().has(&key) {
            return Err(Error::DuplicateTransition);
        }

        env.storage().persistent().set(&key, &true);
        extend_storage_ttl(&env, &key.into_val(&env));

        env.events().publish(
            (
                Symbol::new(&env, "schema_reg"),
                Symbol::new(&env, "register_transition"),
            ),
            (source, target),
        );

        Ok(())
    }

    pub fn is_transition_supported(env: Env, source: SchemaVersion, target: SchemaVersion) -> bool {
        let key = DataKey::SupportedTransition(source, target);
        env.storage()
            .persistent()
            .get::<_, bool>(&key)
            .unwrap_or(false)
    }

    pub fn dry_run(
        env: Env,
        contract: Address,
        source: SchemaVersion,
        target: SchemaVersion,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;

        if target <= source {
            return Err(Error::DowngradeNotAllowed);
        }

        if !Self::is_transition_supported(env.clone(), source, target) {
            return Err(Error::UnsupportedTransition);
        }

        let exec_key = DataKey::MigrationExecuted(contract, source, target);
        if env.storage().persistent().has(&exec_key) {
            return Err(Error::MigrationAlreadyExecuted);
        }

        Ok(())
    }

    pub fn execute_migration(
        env: Env,
        admin: Address,
        contract: Address,
        source: SchemaVersion,
        target: SchemaVersion,
    ) -> Result<u32, Error> {
        require_not_paused(&env)?;
        require_admin(&env, &admin)?;

        Self::dry_run(env.clone(), contract.clone(), source, target)?;

        let count_key = DataKey::ReceiptCount;
        let mut id: u32 = env.storage().persistent().get(&count_key).unwrap_or(0u32);
        id += 1;
        env.storage().persistent().set(&count_key, &id);
        extend_storage_ttl(&env, &count_key.into_val(&env));

        let receipt = MigrationReceipt {
            id,
            contract: contract.clone(),
            from: source,
            to: target,
            executed_at: env.ledger().timestamp(),
            executed_by: admin,
        };

        let receipt_key = DataKey::MigrationReceipt(id);
        env.storage().persistent().set(&receipt_key, &receipt);
        extend_storage_ttl(&env, &receipt_key.into_val(&env));

        let exec_key = DataKey::MigrationExecuted(contract.clone(), source, target);
        env.storage().persistent().set(&exec_key, &true);
        extend_storage_ttl(&env, &exec_key.into_val(&env));

        env.events().publish(
            (
                Symbol::new(&env, "schema_reg"),
                symbol_short!("migrated"),
                contract,
            ),
            (id, source, target),
        );

        Ok(id)
    }

    pub fn get_receipt(env: Env, id: u32) -> Result<MigrationReceipt, Error> {
        let receipt_key = DataKey::MigrationReceipt(id);
        env.storage()
            .persistent()
            .get(&receipt_key)
            .ok_or(Error::ReceiptNotFound)
    }

    pub fn verify_migration(env: Env, id: u32, expected_to: SchemaVersion) -> bool {
        match Self::get_receipt(env, id) {
            Ok(receipt) => receipt.to == expected_to,
            Err(_) => false,
        }
    }

    pub fn registry_version(_env: Env) -> u32 {
        1
    }
}

#[contractimpl]
impl Pausable for SchemaRegistry {
    fn pause(env: Env, admin: Address) -> Result<(), PausableError> {
        require_admin(&env, &admin).map_err(|_| PausableError::NotAuthorized)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish(
            (Symbol::new(&env, "schema_reg"), Symbol::new(&env, "pause")),
            admin,
        );
        Ok(())
    }

    fn unpause(env: Env, admin: Address) -> Result<(), PausableError> {
        require_admin(&env, &admin).map_err(|_| PausableError::NotAuthorized)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (
                Symbol::new(&env, "schema_reg"),
                Symbol::new(&env, "unpause"),
            ),
            admin,
        );
        Ok(())
    }

    fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get::<_, bool>(&DataKey::Paused)
            .unwrap_or(false)
    }
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    require_admin_permission(env, &admin, caller, "require_admin", Error::NotAuthorized)
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    if SchemaRegistry::is_paused(env.clone()) {
        Err(Error::Paused)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod test;
