use crate::{Error, MigrationReceipt, SchemaRegistry, SchemaRegistryClient, SchemaVersion};
use soroban_pausable::PausableError;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

fn setup_env<'a>() -> (Env, Address, Address, SchemaRegistryClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(SchemaRegistry, ());
    let client = SchemaRegistryClient::new(&env, &contract_id);

    client.initialize(&admin);

    (env, admin, user, client)
}

#[test]
fn test_initialize_already_initialized() {
    let (_, admin, _, client) = setup_env();
    let res = client.try_initialize(&admin);
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn test_version_ordering_and_edge_cases() {
    let v1_9_0 = SchemaVersion {
        major: 1,
        minor: 9,
        patch: 0,
    };
    let v1_10_0 = SchemaVersion {
        major: 1,
        minor: 10,
        patch: 0,
    };
    let v1_9_1 = SchemaVersion {
        major: 1,
        minor: 9,
        patch: 1,
    };
    let v2_0_0 = SchemaVersion {
        major: 2,
        minor: 0,
        patch: 0,
    };

    assert!(v1_10_0 > v1_9_0);
    assert!(v1_9_1 > v1_9_0);
    assert!(v2_0_0 > v1_10_0);
    assert_eq!(v1_9_0, v1_9_0);
}

#[test]
fn test_register_transition_and_downgrade_rejected() {
    let (_, admin, user, client) = setup_env();

    let v1 = SchemaVersion {
        major: 1,
        minor: 0,
        patch: 0,
    };
    let v2 = SchemaVersion {
        major: 1,
        minor: 1,
        patch: 0,
    };

    // Non-admin cannot register
    let res = client.try_register_transition(&user, &v1, &v2);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));

    // Downgrade rejected
    let res = client.try_register_transition(&admin, &v2, &v1);
    assert_eq!(res, Err(Ok(Error::DowngradeNotAllowed)));

    // Equal versions rejected
    let res = client.try_register_transition(&admin, &v1, &v1);
    assert_eq!(res, Err(Ok(Error::DowngradeNotAllowed)));

    // Valid registration
    assert!(!client.is_transition_supported(&v1, &v2));
    client.register_transition(&admin, &v1, &v2);
    assert!(client.is_transition_supported(&v1, &v2));

    // Duplicate rejected
    let res = client.try_register_transition(&admin, &v1, &v2);
    assert_eq!(res, Err(Ok(Error::DuplicateTransition)));
}

#[test]
fn test_version_1_10_0_greater_than_1_9_0_registration() {
    let (_, admin, _, client) = setup_env();

    let v1_9 = SchemaVersion {
        major: 1,
        minor: 9,
        patch: 0,
    };
    let v1_10 = SchemaVersion {
        major: 1,
        minor: 10,
        patch: 0,
    };

    client.register_transition(&admin, &v1_9, &v1_10);
    assert!(client.is_transition_supported(&v1_9, &v1_10));
}

#[test]
fn test_dry_run_leaves_no_state_behind() {
    let (env, admin, _, client) = setup_env();
    let target_contract = Address::generate(&env);

    let v1 = SchemaVersion {
        major: 1,
        minor: 0,
        patch: 0,
    };
    let v2 = SchemaVersion {
        major: 2,
        minor: 0,
        patch: 0,
    };

    // Dry run before transition registered -> UnsupportedTransition
    let res = client.try_dry_run(&target_contract, &v1, &v2);
    assert_eq!(res, Err(Ok(Error::UnsupportedTransition)));

    // Register transition
    client.register_transition(&admin, &v1, &v2);

    // Dry run succeeds
    client.dry_run(&target_contract, &v1, &v2);

    // Verify dry run left NO receipt or execution state
    let receipt_res = client.try_get_receipt(&1);
    assert_eq!(receipt_res, Err(Ok(Error::ReceiptNotFound)));
    assert!(!client.verify_migration(&1, &v2));
}

#[test]
fn test_execute_migration_and_double_execution_rejected() {
    let (env, admin, user, client) = setup_env();
    let target_contract = Address::generate(&env);

    let v1 = SchemaVersion {
        major: 1,
        minor: 0,
        patch: 0,
    };
    let v2 = SchemaVersion {
        major: 2,
        minor: 0,
        patch: 0,
    };

    client.register_transition(&admin, &v1, &v2);

    // Non-admin execution rejected
    let res = client.try_execute_migration(&user, &target_contract, &v1, &v2);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));

    // Admin executes migration successfully
    let id = client.execute_migration(&admin, &target_contract, &v1, &v2);
    assert_eq!(id, 1);

    // Verify receipt contents
    let receipt: MigrationReceipt = client.get_receipt(&id);
    assert_eq!(receipt.id, 1);
    assert_eq!(receipt.contract, target_contract);
    assert_eq!(receipt.from, v1);
    assert_eq!(receipt.to, v2);
    assert_eq!(receipt.executed_by, admin);
    assert_eq!(receipt.executed_at, 1_700_000_000);

    // verify_migration helper
    assert!(client.verify_migration(&id, &v2));
    assert!(!client.verify_migration(&id, &v1));
    assert!(!client.verify_migration(&99, &v2));

    // Double execution of the same (contract, source -> target) rejected
    let res = client.try_execute_migration(&admin, &target_contract, &v1, &v2);
    assert_eq!(res, Err(Ok(Error::MigrationAlreadyExecuted)));

    // Dry run for already executed migration also rejected
    let dry_res = client.try_dry_run(&target_contract, &v1, &v2);
    assert_eq!(dry_res, Err(Ok(Error::MigrationAlreadyExecuted)));

    // But another contract can execute the same transition
    let other_contract = Address::generate(&env);
    let id2 = client.execute_migration(&admin, &other_contract, &v1, &v2);
    assert_eq!(id2, 2);
}

#[test]
fn test_pausable_controls() {
    let (env, admin, user, client) = setup_env();
    let target_contract = Address::generate(&env);

    let v1 = SchemaVersion {
        major: 1,
        minor: 0,
        patch: 0,
    };
    let v2 = SchemaVersion {
        major: 2,
        minor: 0,
        patch: 0,
    };

    // Non-admin cannot pause
    let res = client.try_pause(&user);
    assert_eq!(res, Err(Ok(PausableError::NotAuthorized)));

    // Admin pauses
    assert!(!client.is_paused());
    client.pause(&admin);
    assert!(client.is_paused());

    // Operations fail while paused
    let res = client.try_register_transition(&admin, &v1, &v2);
    assert_eq!(res, Err(Ok(Error::Paused)));

    let res = client.try_dry_run(&target_contract, &v1, &v2);
    assert_eq!(res, Err(Ok(Error::Paused)));

    let res = client.try_execute_migration(&admin, &target_contract, &v1, &v2);
    assert_eq!(res, Err(Ok(Error::Paused)));

    // Unpause works
    client.unpause(&admin);
    assert!(!client.is_paused());
    client.register_transition(&admin, &v1, &v2);
    assert!(client.is_transition_supported(&v1, &v2));
}

#[test]
fn test_registry_version() {
    let (_, _, _, client) = setup_env();
    assert_eq!(client.registry_version(), 1);
}
