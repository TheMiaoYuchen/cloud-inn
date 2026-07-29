use crate::redaction::SafeError;
use serde::Serialize;
use zeroize::{Zeroize, ZeroizeOnDrop};

const TOKEN_MAX_BYTES: usize = 4_096;
const KEYCHAIN_ACCOUNT: &str = "nanobanana";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCredentialState {
    Missing,
    Available,
    Locked,
    Denied,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ProviderTokenStatus {
    state: ProviderCredentialState,
}

impl ProviderTokenStatus {
    fn new(state: ProviderCredentialState) -> Self {
        Self { state }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeychainScope {
    service: String,
    account: String,
}

impl KeychainScope {
    fn for_runtime(bundle_identifier: &str) -> Result<Self, SafeError> {
        let environment =
            option_env!("CLOUD_INN_KEYCHAIN_ENV").unwrap_or(if cfg!(debug_assertions) {
                "development"
            } else {
                "production"
            });
        Self::new(bundle_identifier, environment)
    }

    fn new(bundle_identifier: &str, environment: &str) -> Result<Self, SafeError> {
        if !valid_scope_component(bundle_identifier, 255) || !valid_scope_component(environment, 32)
        {
            return Err(SafeError::new("keychain.unavailable", "钥匙串隔离标识无效"));
        }
        let service = if environment == "production" {
            format!("{bundle_identifier}.api-nebula")
        } else {
            format!("{bundle_identifier}.{environment}.api-nebula")
        };
        Ok(Self {
            service,
            account: KEYCHAIN_ACCOUNT.to_string(),
        })
    }
}

fn valid_scope_component(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct SecretToken(String);

impl SecretToken {
    fn parse(value: String) -> Result<Self, SafeError> {
        let token = Self(value);
        let byte_length = token.0.len();
        if byte_length == 0 || byte_length > TOKEN_MAX_BYTES {
            return Err(SafeError::new("keychain.invalid-token", "令牌长度无效"));
        }
        if token.0.chars().any(char::is_control)
            || token.0.starts_with(char::is_whitespace)
            || token.0.ends_with(char::is_whitespace)
        {
            return Err(SafeError::new("keychain.invalid-token", "令牌格式无效"));
        }
        Ok(token)
    }

    fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StoreFailure {
    Locked,
    Denied,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StoreProbe {
    Missing,
    Available,
}

pub(crate) trait CredentialStore: Send + Sync + 'static {
    fn probe(&self, scope: &KeychainScope) -> Result<StoreProbe, StoreFailure>;
    fn set(&self, scope: &KeychainScope, token: &SecretToken) -> Result<(), StoreFailure>;
    fn delete(&self, scope: &KeychainScope) -> Result<bool, StoreFailure>;
}

pub(crate) struct KeychainService<S: CredentialStore> {
    scope: KeychainScope,
    store: S,
}

impl<S: CredentialStore> KeychainService<S> {
    fn new(scope: KeychainScope, store: S) -> Self {
        Self { scope, store }
    }

    pub fn status(&self) -> ProviderTokenStatus {
        let state = match self.store.probe(&self.scope) {
            Ok(StoreProbe::Missing) => ProviderCredentialState::Missing,
            Ok(StoreProbe::Available) => ProviderCredentialState::Available,
            Err(StoreFailure::Locked) => ProviderCredentialState::Locked,
            Err(StoreFailure::Denied) => ProviderCredentialState::Denied,
            Err(StoreFailure::Unavailable) => ProviderCredentialState::Unavailable,
        };
        ProviderTokenStatus::new(state)
    }

    pub fn set_token(&self, value: String) -> Result<ProviderTokenStatus, SafeError> {
        let token = SecretToken::parse(value)?;
        self.store.set(&self.scope, &token).map_err(store_error)?;
        Ok(ProviderTokenStatus::new(ProviderCredentialState::Available))
    }

    pub fn delete_token(&self) -> Result<ProviderTokenStatus, SafeError> {
        self.store.delete(&self.scope).map_err(store_error)?;
        Ok(ProviderTokenStatus::new(ProviderCredentialState::Missing))
    }
}

fn store_error(failure: StoreFailure) -> SafeError {
    match failure {
        StoreFailure::Locked => SafeError::new("keychain.locked", "钥匙串尚未解锁"),
        StoreFailure::Denied => SafeError::new("keychain.denied", "钥匙串访问被拒绝"),
        StoreFailure::Unavailable => SafeError::new("keychain.unavailable", "钥匙串暂时不可用"),
    }
}

#[derive(Default)]
pub struct PlatformCredentialStore;

pub type PlatformKeychainService = KeychainService<PlatformCredentialStore>;

pub fn platform_service(bundle_identifier: &str) -> Result<PlatformKeychainService, SafeError> {
    Ok(KeychainService::new(
        KeychainScope::for_runtime(bundle_identifier)?,
        PlatformCredentialStore,
    ))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::base::Error;
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    };
    use zeroize::Zeroize;

    const ERR_SEC_USER_CANCELED: i32 = -128;
    const ERR_SEC_NOT_AVAILABLE: i32 = -25_291;
    const ERR_SEC_AUTH_FAILED: i32 = -25_293;
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25_308;
    const ERR_SEC_MISSING_ENTITLEMENT: i32 = -34_018;

    impl CredentialStore for PlatformCredentialStore {
        fn probe(&self, scope: &KeychainScope) -> Result<StoreProbe, StoreFailure> {
            let options = lookup_options(scope);
            match generic_password(options) {
                Ok(mut bytes) => {
                    let valid = valid_existing_token(&bytes);
                    bytes.zeroize();
                    if valid {
                        Ok(StoreProbe::Available)
                    } else {
                        Err(StoreFailure::Unavailable)
                    }
                }
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(StoreProbe::Missing),
                Err(error) => Err(map_security_error(error)),
            }
        }

        fn set(&self, scope: &KeychainScope, token: &SecretToken) -> Result<(), StoreFailure> {
            let mut options = lookup_options(scope);
            let access_control = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                0,
            )
            .map_err(map_security_error)?;
            options.set_access_control(access_control);
            set_generic_password_options(token.as_bytes(), options).map_err(map_security_error)
        }

        fn delete(&self, scope: &KeychainScope) -> Result<bool, StoreFailure> {
            match delete_generic_password_options(lookup_options(scope)) {
                Ok(()) => Ok(true),
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
                Err(error) => Err(map_security_error(error)),
            }
        }
    }

    fn lookup_options(scope: &KeychainScope) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(&scope.service, &scope.account);
        options.set_access_synchronized(Some(false));
        options.use_protected_keychain();
        options
    }

    fn valid_existing_token(bytes: &[u8]) -> bool {
        std::str::from_utf8(bytes).is_ok_and(|value| {
            !value.is_empty()
                && value.len() <= TOKEN_MAX_BYTES
                && !value.chars().any(char::is_control)
                && !value.starts_with(char::is_whitespace)
                && !value.ends_with(char::is_whitespace)
        })
    }

    fn map_security_error(error: Error) -> StoreFailure {
        match error.code() {
            ERR_SEC_INTERACTION_NOT_ALLOWED => StoreFailure::Locked,
            ERR_SEC_AUTH_FAILED | ERR_SEC_USER_CANCELED | ERR_SEC_MISSING_ENTITLEMENT => {
                StoreFailure::Denied
            }
            ERR_SEC_NOT_AVAILABLE => StoreFailure::Unavailable,
            _ => StoreFailure::Unavailable,
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl CredentialStore for PlatformCredentialStore {
    fn probe(&self, _scope: &KeychainScope) -> Result<StoreProbe, StoreFailure> {
        Err(StoreFailure::Unavailable)
    }

    fn set(&self, _scope: &KeychainScope, _token: &SecretToken) -> Result<(), StoreFailure> {
        Err(StoreFailure::Unavailable)
    }

    fn delete(&self, _scope: &KeychainScope) -> Result<bool, StoreFailure> {
        Err(StoreFailure::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use zeroize::Zeroizing;

    #[derive(Default)]
    struct MockStore {
        state: Mutex<MockState>,
    }

    #[derive(Default)]
    struct MockState {
        token: Option<Zeroizing<Vec<u8>>>,
        failure: Option<StoreFailure>,
    }

    impl MockStore {
        fn fail_with(&self, failure: StoreFailure) {
            self.state.lock().unwrap().failure = Some(failure);
        }

        fn clear_failure(&self) {
            self.state.lock().unwrap().failure = None;
        }

        fn token_bytes(&self) -> Option<Vec<u8>> {
            self.state
                .lock()
                .unwrap()
                .token
                .as_ref()
                .map(|token| token.to_vec())
        }
    }

    impl CredentialStore for MockStore {
        fn probe(&self, _scope: &KeychainScope) -> Result<StoreProbe, StoreFailure> {
            let state = self.state.lock().unwrap();
            if let Some(failure) = state.failure {
                return Err(failure);
            }
            Ok(if state.token.is_some() {
                StoreProbe::Available
            } else {
                StoreProbe::Missing
            })
        }

        fn set(&self, _scope: &KeychainScope, token: &SecretToken) -> Result<(), StoreFailure> {
            let mut state = self.state.lock().unwrap();
            if let Some(failure) = state.failure {
                return Err(failure);
            }
            state.token = Some(Zeroizing::new(token.as_bytes().to_vec()));
            Ok(())
        }

        fn delete(&self, _scope: &KeychainScope) -> Result<bool, StoreFailure> {
            let mut state = self.state.lock().unwrap();
            if let Some(failure) = state.failure {
                return Err(failure);
            }
            Ok(state.token.take().is_some())
        }
    }

    fn service() -> KeychainService<MockStore> {
        KeychainService::new(
            KeychainScope::new("com.cloudinn.game", "test").unwrap(),
            MockStore::default(),
        )
    }

    #[test]
    fn scope_isolates_bundle_and_environment_without_changing_account() {
        let production = KeychainScope::new("com.cloudinn.game", "production").unwrap();
        let development = KeychainScope::new("com.cloudinn.game", "development").unwrap();
        let smoke = KeychainScope::new("com.cloudinn.game.phase5-smoke", "production").unwrap();
        assert_eq!(production.service, "com.cloudinn.game.api-nebula");
        assert_eq!(
            development.service,
            "com.cloudinn.game.development.api-nebula"
        );
        assert_eq!(smoke.service, "com.cloudinn.game.phase5-smoke.api-nebula");
        assert_ne!(production.service, development.service);
        assert_ne!(production.service, smoke.service);
        assert_eq!(production.account, KEYCHAIN_ACCOUNT);
        assert_eq!(development.account, KEYCHAIN_ACCOUNT);
    }

    #[test]
    fn scope_rejects_unsafe_components() {
        for (bundle, environment) in [
            ("", "production"),
            (".com.cloudinn", "production"),
            ("com/cloudinn", "production"),
            ("com.cloudinn.", "production"),
            ("com.cloudinn", "bad environment"),
        ] {
            assert!(KeychainScope::new(bundle, environment).is_err());
        }
    }

    #[test]
    fn status_exposes_all_five_states_without_a_token_getter() {
        let service = service();
        assert_eq!(service.status().state, ProviderCredentialState::Missing);
        service.set_token("valid-token".into()).unwrap();
        assert_eq!(service.status().state, ProviderCredentialState::Available);
        for (failure, expected) in [
            (StoreFailure::Locked, ProviderCredentialState::Locked),
            (StoreFailure::Denied, ProviderCredentialState::Denied),
            (
                StoreFailure::Unavailable,
                ProviderCredentialState::Unavailable,
            ),
        ] {
            service.store.fail_with(failure);
            assert_eq!(service.status().state, expected);
            service.store.clear_failure();
        }
    }

    #[test]
    fn accepts_exact_utf8_bytes_without_trimming_or_normalizing() {
        let service = service();
        let token = "令牌 middle é".to_string();
        service.set_token(token.clone()).unwrap();
        assert_eq!(
            service.store.token_bytes().unwrap(),
            token.as_bytes().to_vec()
        );

        let maximum = "é".repeat(TOKEN_MAX_BYTES / 2);
        service.set_token(maximum.clone()).unwrap();
        assert_eq!(
            service.store.token_bytes().unwrap(),
            maximum.as_bytes().to_vec()
        );
    }

    #[test]
    fn rejects_empty_oversize_control_and_boundary_whitespace_without_echo() {
        let invalid = [
            String::new(),
            "x".repeat(TOKEN_MAX_BYTES + 1),
            " token".to_string(),
            "token ".to_string(),
            "\ttoken".to_string(),
            "token\nvalue".to_string(),
            "token\0value".to_string(),
            "token\u{007f}value".to_string(),
        ];
        for token in invalid {
            let service = service();
            let marker = token.chars().take(16).collect::<String>();
            let error = service.set_token(token).unwrap_err();
            let serialized = serde_json::to_string(&error).unwrap();
            if !marker.is_empty() {
                assert!(!serialized.contains(&marker), "{serialized}");
            }
            assert!(service.store.token_bytes().is_none());
        }
    }

    #[test]
    fn mutation_failures_have_stable_non_secret_codes() {
        for (failure, code) in [
            (StoreFailure::Locked, "keychain.locked"),
            (StoreFailure::Denied, "keychain.denied"),
            (StoreFailure::Unavailable, "keychain.unavailable"),
        ] {
            let service = service();
            service.store.fail_with(failure);
            let error = service.set_token("sentinel-secret".into()).unwrap_err();
            let serialized = serde_json::to_string(&error).unwrap();
            assert!(serialized.contains(code), "{serialized}");
            assert!(!serialized.contains("sentinel-secret"), "{serialized}");
        }
    }

    #[test]
    fn delete_is_idempotent_and_returns_missing() {
        let service = service();
        assert_eq!(
            service.delete_token().unwrap().state,
            ProviderCredentialState::Missing
        );
        service.set_token("valid-token".into()).unwrap();
        assert_eq!(
            service.delete_token().unwrap().state,
            ProviderCredentialState::Missing
        );
        assert_eq!(service.status().state, ProviderCredentialState::Missing);
    }

    #[test]
    fn status_serializes_only_the_state() {
        let service = service();
        assert_eq!(
            serde_json::to_string(&service.status()).unwrap(),
            r#"{"state":"missing"}"#
        );
    }
}
