#[cfg(test)]
mod tests {
    use crate::{Timelock, TimelockClient, TimelockError, GRACE_PERIOD};
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
        xdr::ToXdr,
        Address, BytesN, Env, IntoVal, Symbol, TryIntoVal, Val, Vec,
    };

    #[contract]
    pub struct MockTarget;

    #[contractimpl]
    impl MockTarget {
        pub fn admin_op(env: Env, admin: Address) {
            admin.require_auth();
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "done"), &true);
        }

        pub fn is_done(env: Env) -> bool {
            env.storage()
                .instance()
                .get(&Symbol::new(&env, "done"))
                .unwrap_or(false)
        }
    }

    fn setup(env: &Env) -> (Address, TimelockClient<'_>, Address, Address) {
        env.mock_all_auths();
        let timelock_id = env.register(Timelock, ());
        let client = TimelockClient::new(env, &timelock_id);
        let admin = Address::generate(env);
        let member = Address::generate(env);
        let mut members = Vec::new(env);
        members.push_back(member.clone());
        members.push_back(member.clone());
        client.init(&admin, &3600u64, &604800u64, &members);
        (timelock_id, client, admin, member)
    }

    fn queue_op(
        env: &Env,
        contract_id: &Address,
        client: &TimelockClient,
        admin: &Address,
        target: &Address,
        delay: u64,
    ) -> (u64, Symbol, Vec<soroban_sdk::Val>) {
        let function = Symbol::new(env, "test_fn");
        let args = Vec::new(env);

        env.mock_auths(&[MockAuth {
            address: admin,
            invoke: &MockAuthInvoke {
                contract: contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(env),
                sub_invokes: &[],
            },
        }]);
        client.queue(admin, target, &function, &args, &delay);
        (env.ledger().timestamp() + delay, function, args)
    }

    #[test]
    fn enforce_delay_returns_timestamp_not_met() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let delay = 86400u64;
        let (eta, function, args) = queue_op(&env, &contract_id, &client, &admin, &target, delay);

        let result = client.try_execute(&target, &function, &args, &eta);
        assert!(matches!(result, Err(Ok(TimelockError::TimestampNotMet))));
    }

    #[test]
    fn execute_after_delay_succeeds() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target_id = env.register(MockTarget, ());
        let target_client = MockTargetClient::new(&env, &target_id);
        let function = Symbol::new(&env, "admin_op");
        let mut args = Vec::new(&env);
        args.push_back(client.address.to_val());
        let delay = 3600u64;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target_id.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.queue(&admin, &target_id, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        env.ledger().set_timestamp(eta + 1);
        client.execute(&target_id, &function, &args, &eta);
        assert!(target_client.is_done());
    }

    #[test]
    fn expired_operation_returns_transaction_expired() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let delay = 3600u64;
        let (eta, function, args) = queue_op(&env, &contract_id, &client, &admin, &target, delay);

        env.ledger().set_timestamp(eta + GRACE_PERIOD + 1);
        let result = client.try_execute(&target, &function, &args, &eta);
        assert!(matches!(result, Err(Ok(TimelockError::TransactionExpired))));
    }

    #[test]
    fn non_admin_cannot_queue() {
        let env = Env::default();
        let (contract_id, client, _admin, _) = setup(&env);
        let stranger = Address::generate(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    stranger.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    86400u64,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_queue(&stranger, &target, &function, &args, &86400u64);
        assert!(matches!(result, Err(Ok(TimelockError::NotAuthorized))));
    }

    #[test]
    fn cancel_prevents_execution() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);
        let delay = 86400u64;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel",
                args: (admin.clone(), tx_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.cancel(&admin, &tx_hash);

        env.ledger().set_timestamp(eta + 1);
        let result = client.try_execute(&target, &function, &args, &eta);
        assert!(matches!(
            result,
            Err(Ok(TimelockError::TransactionNotQueued))
        ));
    }

    #[test]
    fn duplicate_queue_returns_already_queued() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "dup_fn");
        let args = Vec::new(&env);
        let delay = 86400u64;

        let auth = MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        };
        env.mock_auths(&[auth.clone()]);
        client.queue(&admin, &target, &function, &args, &delay);

        env.mock_auths(&[auth]);
        let result = client.try_queue(&admin, &target, &function, &args, &delay);
        assert!(matches!(
            result,
            Err(Ok(TimelockError::TransactionAlreadyQueued))
        ));
    }

    #[test]
    fn admin_can_increase_min_delay() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_min_delay",
                args: (admin.clone(), 172800u64).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_set_min_delay(&admin, &172800u64);
        assert!(result.is_ok());

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_min_delay",
                args: (admin.clone(), 43200u64).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let decrease = client.try_set_min_delay(&admin, &43200u64);
        assert!(matches!(decrease, Err(Ok(TimelockError::InvalidDelay))));
    }

    #[test]
    fn zero_min_delay_rejected_on_init() {
        let env = Env::default();
        let contract_id = env.register(Timelock, ());
        let client = TimelockClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let member = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member.clone());
        members.push_back(member);

        env.mock_all_auths();
        let result = client.try_init(&admin, &0u64, &604800u64, &members);
        assert!(matches!(result, Err(Ok(TimelockError::InvalidDelay))));
    }

    // ==================== EMERGENCY PAUSE / UNPAUSE / EXPIRE TESTS ====================

    #[test]
    fn execute_rejected_when_paused() {
        let env = Env::default();
        let (contract_id, client, admin, member) = setup(&env);
        let target_id = env.register(MockTarget, ());
        let target_client = MockTargetClient::new(&env, &target_id);
        let function = Symbol::new(&env, "admin_op");
        let mut args = Vec::new(&env);
        args.push_back(client.address.to_val());
        let delay = 3600u64;

        // Queue operation
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target_id.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.queue(&admin, &target_id, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        // Advance time past delay
        env.ledger().set_timestamp(eta + 1);

        // Emergency pause with multisig
        let mut signed_members = Vec::new(&env);
        signed_members.push_back(member.clone());
        signed_members.push_back(member.clone());

        env.mock_auths(&[
            MockAuth {
                address: &member,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "emergency_pause",
                    args: (signed_members.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
            MockAuth {
                address: &member,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "emergency_pause",
                    args: (signed_members.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ]);
        client.emergency_pause(&signed_members);

        // Try to execute while paused - should fail
        let result = client.try_execute(&target_id, &function, &args, &eta);
        assert!(matches!(result, Err(Ok(TimelockError::ContractPaused))));

        // Verify operation was not executed
        assert!(!target_client.is_done());
    }

    #[test]
    fn unpause_allows_execution_after_pause() {
        let env = Env::default();
        let (contract_id, client, admin, member) = setup(&env);
        let target_id = env.register(MockTarget, ());
        let target_client = MockTargetClient::new(&env, &target_id);
        let function = Symbol::new(&env, "admin_op");
        let mut args = Vec::new(&env);
        args.push_back(client.address.to_val());
        let delay = 3600u64;

        // Queue operation
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target_id.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.queue(&admin, &target_id, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        // Advance time past delay
        env.ledger().set_timestamp(eta + 1);

        // Emergency pause
        let mut signed_members = Vec::new(&env);
        signed_members.push_back(member.clone());
        signed_members.push_back(member.clone());

        env.mock_auths(&[
            MockAuth {
                address: &member,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "emergency_pause",
                    args: (signed_members.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
            MockAuth {
                address: &member,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "emergency_pause",
                    args: (signed_members.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ]);
        client.emergency_pause(&signed_members);

        // Verify execution is blocked
        let result = client.try_execute(&target_id, &function, &args, &eta);
        assert!(matches!(result, Err(Ok(TimelockError::ContractPaused))));

        // Unpause
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause",
                args: (admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.unpause(&admin);

        // Now execution should succeed
        client.execute(&target_id, &function, &args, &eta);
        assert!(target_client.is_done());
    }

    #[test]
    fn non_admin_cannot_unpause() {
        let env = Env::default();
        let (contract_id, client, admin, member) = setup(&env);

        // Emergency pause
        let mut signed_members = Vec::new(&env);
        signed_members.push_back(member.clone());
        signed_members.push_back(member.clone());

        env.mock_auths(&[
            MockAuth {
                address: &member,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "emergency_pause",
                    args: (signed_members.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
            MockAuth {
                address: &member,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "emergency_pause",
                    args: (signed_members.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ]);
        client.emergency_pause(&signed_members);

        // Try to unpause as non-admin
        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause",
                args: (stranger.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_unpause(&stranger);
        assert!(matches!(result, Err(Ok(TimelockError::NotAuthorized))));
    }

    #[test]
    fn expire_requires_grace_period_elapsed() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);
        let delay = 3600u64;

        // Queue operation
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        // Try to expire before grace period elapsed - should fail
        env.ledger().set_timestamp(eta + GRACE_PERIOD / 2);
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "expire",
                args: (admin.clone(), tx_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_expire(&admin, &tx_hash);
        assert!(matches!(result, Err(Ok(TimelockError::TimestampNotMet))));

        // Advance past grace period
        env.ledger().set_timestamp(eta + GRACE_PERIOD + 1);

        // Now expire should succeed
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "expire",
                args: (admin.clone(), tx_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_expire(&admin, &tx_hash);
        assert!(result.is_ok());
    }

    #[test]
    fn non_admin_cannot_expire() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);
        let delay = 3600u64;

        // Queue operation
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        // Advance past grace period
        env.ledger().set_timestamp(eta + GRACE_PERIOD + 1);

        // Try to expire as non-admin
        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "expire",
                args: (stranger.clone(), tx_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_expire(&stranger, &tx_hash);
        assert!(matches!(result, Err(Ok(TimelockError::NotAuthorized))));
    }

    #[test]
    fn expire_rejects_non_queued_transaction() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);

        // Create a fake hash by using a known value
        let mut hash_data = Vec::<Val>::new(&env);
        hash_data.push_back(0u64.into_val(&env));
        let fake_hash = env.crypto().sha256(&hash_data.to_xdr(&env));
        let fake_hash_n: soroban_sdk::BytesN<32> = fake_hash.into();

        // Advance time
        env.ledger().set_timestamp(GRACE_PERIOD + 10000);

        // Try to expire non-existent transaction
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "expire",
                args: (admin.clone(), fake_hash_n.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_expire(&admin, &fake_hash_n);
        assert!(matches!(
            result,
            Err(Ok(TimelockError::TransactionNotQueued))
        ));
    }

    // ==================== TIMING BOUNDARY TESTS ====================

    /// Execute exactly at eta (now == eta) must succeed — the contract uses
    /// `now < eta` for the early-rejection guard, so the boundary is inclusive.
    #[test]
    fn execute_exactly_at_eta_succeeds() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target_id = env.register(MockTarget, ());
        let target_client = MockTargetClient::new(&env, &target_id);
        let function = Symbol::new(&env, "admin_op");
        let mut args = Vec::new(&env);
        args.push_back(client.address.to_val());
        let delay = 3600u64;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target_id.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.queue(&admin, &target_id, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        // Advance to exactly eta — the inclusive boundary
        env.ledger().set_timestamp(eta);
        client.execute(&target_id, &function, &args, &eta);
        assert!(target_client.is_done());
    }

    /// Execute at exactly eta + GRACE_PERIOD must succeed — the contract uses
    /// `now > eta + GRACE_PERIOD` for expiry, so the boundary is inclusive.
    /// One second later it would be TransactionExpired (covered by the
    /// existing `expired_operation_returns_transaction_expired` test).
    #[test]
    fn execute_at_grace_period_boundary_succeeds() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target_id = env.register(MockTarget, ());
        let target_client = MockTargetClient::new(&env, &target_id);
        let function = Symbol::new(&env, "admin_op");
        let mut args = Vec::new(&env);
        args.push_back(client.address.to_val());
        let delay = 3600u64;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target_id.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.queue(&admin, &target_id, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        // Advance to exactly eta + GRACE_PERIOD — last moment before expiry
        env.ledger().set_timestamp(eta + GRACE_PERIOD);
        client.execute(&target_id, &function, &args, &eta);
        assert!(target_client.is_done());
    }

    // ==================== CANCEL + RE-QUEUE TESTS ====================

    /// After cancelling a queued operation, the same (target, function, args,
    /// delay) can be re-queued at the same ledger time because cancel removed
    /// the storage entry. The hash is identical (eta = now + delay, and now is
    /// unchanged), proving the slot was actually freed.
    #[test]
    fn cancel_then_requeue_same_hash_succeeds() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);
        let delay = 86400u64;

        // Queue
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target, &function, &args, &delay);

        // Cancel
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel",
                args: (admin.clone(), tx_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.cancel(&admin, &tx_hash);

        // Re-queue the same operation at the same ledger time → same hash.
        // This succeeds because cancel removed the temporary storage entry.
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let requeued_hash = client.queue(&admin, &target, &function, &args, &delay);
        assert_eq!(tx_hash, requeued_hash, "re-queued hash must match original");

        // A duplicate queue now fails with AlreadyQueued, proving the entry
        // exists again (cancel truly freed and re-queue truly re-created it).
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let dup = client.try_queue(&admin, &target, &function, &args, &delay);
        assert!(matches!(
            dup,
            Err(Ok(TimelockError::TransactionAlreadyQueued))
        ));
    }

    // ==================== EMERGENCY PAUSE QUORUM TESTS ====================

    /// emergency_pause requires at least 2 member signatures (quorum).
    /// A single member must be rejected with InsufficientMultisigApprovals.
    #[test]
    fn emergency_pause_rejects_insufficient_quorum() {
        let env = Env::default();
        let (contract_id, client, _admin, member) = setup(&env);

        let mut single = Vec::new(&env);
        single.push_back(member.clone());

        env.mock_auths(&[MockAuth {
            address: &member,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "emergency_pause",
                args: (single.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_emergency_pause(&single);
        assert!(matches!(
            result,
            Err(Ok(TimelockError::InsufficientMultisigApprovals))
        ));
    }

    /// emergency_pause rejects any member not in the configured multisig set.
    /// The valid member passes require_auth and the contains check; the
    /// stranger passes require_auth (mocked) but fails the contains check.
    #[test]
    fn emergency_pause_rejects_non_member() {
        let env = Env::default();
        let (contract_id, client, _admin, member) = setup(&env);
        let stranger = Address::generate(&env);

        let mut members = Vec::new(&env);
        members.push_back(member.clone());
        members.push_back(stranger.clone());

        env.mock_auths(&[
            MockAuth {
                address: &member,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "emergency_pause",
                    args: (members.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
            MockAuth {
                address: &stranger,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "emergency_pause",
                    args: (members.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ]);
        let result = client.try_emergency_pause(&members);
        assert!(matches!(result, Err(Ok(TimelockError::NotAuthorized))));
    }

    // ==================== AUTH ON EVERY ENTRY POINT ====================

    /// Non-admin cannot cancel a queued operation.
    #[test]
    fn non_admin_cannot_cancel() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);
        let delay = 86400u64;

        // Queue as admin
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target, &function, &args, &delay);

        // Try to cancel as non-admin
        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel",
                args: (stranger.clone(), tx_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_cancel(&stranger, &tx_hash);
        assert!(matches!(result, Err(Ok(TimelockError::NotAuthorized))));
    }

    /// Non-admin cannot change the minimum delay.
    #[test]
    fn non_admin_cannot_set_min_delay() {
        let env = Env::default();
        let (contract_id, client, _admin, _) = setup(&env);
        let stranger = Address::generate(&env);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_min_delay",
                args: (stranger.clone(), 172800u64).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_set_min_delay(&stranger, &172800u64);
        assert!(matches!(result, Err(Ok(TimelockError::NotAuthorized))));
    }

    // ==================== EVENT EMISSION TESTS ====================
    //
    // These verify that events emitted by the timelock contract match the
    // format expected by backend/src/indexer/event-parser.ts
    // (parseTimelockEvent):
    //   topics[0] == "governance"
    //   topics[1] == action ("queued" | "executed" | "cancelled")
    //   queued    data: [txHash, target, functionName, args, eta] (5-tuple)
    //   executed  data: txHash  (single BytesN<32>)
    //   cancelled data: txHash  (single BytesN<32>)

    #[test]
    fn queue_emits_governance_queued_event() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);
        let delay = 86400u64;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        let events = env.events().all();
        let last = events.last().unwrap();
        let topics: Vec<Val> = last.1;
        assert_eq!(topics.len(), 2, "queued event must have 2 topics");
        let category: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(category, Symbol::new(&env, "governance"));
        let action: Symbol = topics.get(1).unwrap().try_into_val(&env).unwrap();
        assert_eq!(action, Symbol::new(&env, "queued"));

        // Data must be a 5-tuple matching backend parseTimelockEvent("queued"):
        //   [txHash, target, functionName, args, eta]
        let data: Vec<Val> = last.2.try_into_val(&env).unwrap();
        assert_eq!(data.len(), 5, "queued event data must have 5 elements");
        let event_tx_hash: BytesN<32> = data.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(event_tx_hash, tx_hash);
        let event_target: Address = data.get(1).unwrap().try_into_val(&env).unwrap();
        assert_eq!(event_target, target);
        let event_function: Symbol = data.get(2).unwrap().try_into_val(&env).unwrap();
        assert_eq!(event_function, function);
        let event_eta: u64 = data.get(4).unwrap().try_into_val(&env).unwrap();
        assert_eq!(event_eta, eta);
    }

    #[test]
    fn execute_emits_governance_executed_event() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target_id = env.register(MockTarget, ());
        let function = Symbol::new(&env, "admin_op");
        let mut args = Vec::new(&env);
        args.push_back(client.address.to_val());
        let delay = 3600u64;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target_id.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target_id, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        env.ledger().set_timestamp(eta + 1);
        client.execute(&target_id, &function, &args, &eta);

        // The "executed" event is the last event emitted (MockTarget.admin_op
        // publishes no events of its own).
        let events = env.events().all();
        let last = events.last().unwrap();
        let topics: Vec<Val> = last.1;
        assert_eq!(topics.len(), 2);
        let category: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(category, Symbol::new(&env, "governance"));
        let action: Symbol = topics.get(1).unwrap().try_into_val(&env).unwrap();
        assert_eq!(action, Symbol::new(&env, "executed"));

        // Data must be a single BytesN<32> matching backend
        // parseTimelockEvent("executed"), which expects `typeof d === 'string'`.
        let event_tx_hash: BytesN<32> = last.2.try_into_val(&env).unwrap();
        assert_eq!(event_tx_hash, tx_hash);
    }

    #[test]
    fn cancel_emits_governance_cancelled_event() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);
        let delay = 86400u64;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target, &function, &args, &delay);

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel",
                args: (admin.clone(), tx_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.cancel(&admin, &tx_hash);

        let events = env.events().all();
        let last = events.last().unwrap();
        let topics: Vec<Val> = last.1;
        assert_eq!(topics.len(), 2);
        let category: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(category, Symbol::new(&env, "governance"));
        let action: Symbol = topics.get(1).unwrap().try_into_val(&env).unwrap();
        assert_eq!(action, Symbol::new(&env, "cancelled"));

        // Data must be a single BytesN<32> matching backend
        // parseTimelockEvent("cancelled"), which expects `typeof d === 'string'`.
        let event_tx_hash: BytesN<32> = last.2.try_into_val(&env).unwrap();
        assert_eq!(event_tx_hash, tx_hash);
    }

    /// The `expire` function emits a `("timelock", "operation_expired")` event
    /// with data `(tx_hash, stored_eta)`.
    ///
    /// MISMATCH with the backend indexer (reported in PR description):
    /// `parseTimelockEvent` only accepts events whose first topic is
    /// `"governance"`, but this event uses `"timelock"`, so the parser
    /// returns `null` and drops it. `TimelockProcessor` has no handler for
    /// `"operation_expired"`, and `TimelockStatus` has no `'expired'` variant.
    /// Net effect: expired operations are never indexed by the backend.
    #[test]
    fn expire_emits_operation_expired_event() {
        let env = Env::default();
        let (contract_id, client, admin, _) = setup(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "test_fn");
        let args = Vec::new(&env);
        let delay = 3600u64;

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "queue",
                args: (
                    admin.clone(),
                    target.clone(),
                    function.clone(),
                    args.clone(),
                    delay,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let tx_hash = client.queue(&admin, &target, &function, &args, &delay);
        let eta = env.ledger().timestamp() + delay;

        // Advance past grace period
        env.ledger().set_timestamp(eta + GRACE_PERIOD + 1);

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "expire",
                args: (admin.clone(), tx_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.expire(&admin, &tx_hash);

        let events = env.events().all();
        let last = events.last().unwrap();
        let topics: Vec<Val> = last.1;
        assert_eq!(topics.len(), 2);
        let category: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        // Contract emits "timelock" (NOT "governance" — see mismatch note above)
        assert_eq!(category, Symbol::new(&env, "timelock"));
        let action: Symbol = topics.get(1).unwrap().try_into_val(&env).unwrap();
        assert_eq!(action, Symbol::new(&env, "operation_expired"));

        // Data is a 2-tuple (tx_hash, stored_eta)
        let data: Vec<Val> = last.2.try_into_val(&env).unwrap();
        assert_eq!(data.len(), 2);
        let event_tx_hash: BytesN<32> = data.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(event_tx_hash, tx_hash);
        let event_eta: u64 = data.get(1).unwrap().try_into_val(&env).unwrap();
        assert_eq!(event_eta, eta);
    }
}
