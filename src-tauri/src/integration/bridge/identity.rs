use crate::core::error::AppError;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use crypto_box::aead::OsRng;
use crypto_box::{PublicKey, SecretKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const IDENTITY_FILE: &str = "identity.json";
const DEVICES_FILE: &str = "devices.json";
const CLIENT_IDENTITY_FILE: &str = "client-identity.json";
const CLIENT_PROFILE_FILE: &str = "client-profile.json";
#[cfg(target_os = "ios")]
const IOS_KEYCHAIN_SERVICE: &str = "com.poco-ai.agentero.bridge";
#[cfg(target_os = "ios")]
const IOS_KEYCHAIN_ACCOUNT: &str = "client-identity-v2";

/// Long-lived desktop identity. The secret key stays in the local config dir
/// and is never added to a QR offer or sent to the Relay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeIdentity {
    pub v: u8,
    pub server_id: String,
    pub public_key_b64: String,
    pub secret_key_b64: String,
    pub created_at: DateTime<Utc>,
}

impl BridgeIdentity {
    pub fn create() -> Self {
        let secret = SecretKey::generate(&mut OsRng);
        let public = secret.public_key();
        let server_id = format!(
            "agt_{}",
            URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes())
        );
        Self {
            v: 1,
            server_id,
            public_key_b64: URL_SAFE_NO_PAD.encode(public.as_bytes()),
            secret_key_b64: URL_SAFE_NO_PAD.encode(secret.to_bytes()),
            created_at: Utc::now(),
        }
    }

    pub fn secret_key(&self) -> Result<SecretKey, AppError> {
        let bytes = decode_32(&self.secret_key_b64, "Bridge secret key")?;
        Ok(SecretKey::from(bytes))
    }

    pub fn public_key(&self) -> Result<PublicKey, AppError> {
        let bytes = decode_32(&self.public_key_b64, "Bridge public key")?;
        Ok(PublicKey::from(bytes))
    }
}

/// A client device that was manually approved by the desktop user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeDevice {
    pub device_id: String,
    pub name: String,
    pub public_key_b64: String,
    pub paired_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub revoked: bool,
}

/// Long-lived Ed25519 identity for one mobile device. Its public half is sent
/// only in an encrypted `pair_request`; the secret half signs each future
/// connection challenge and is stored in the iOS Keychain on mobile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeClientIdentity {
    pub v: u8,
    pub device_id: String,
    pub public_key_b64: String,
    pub secret_key_b64: String,
    pub created_at: DateTime<Utc>,
}

/// The non-secret connection profile for the most recently paired desktop.
/// The device signing key remains in `BridgeClientIdentity`; this record only
/// tells iOS which Relay endpoint and server should be resumed at launch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeClientProfile {
    pub offer_url: String,
    pub device_name: String,
    pub paired: bool,
}

impl BridgeClientIdentity {
    pub fn create() -> Self {
        let secret =
            SigningKey::from_bytes(&crypto_box::SecretKey::generate(&mut OsRng).to_bytes());
        let public = secret.verifying_key();
        Self {
            v: 2,
            device_id: format!(
                "ios_{}",
                URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes())
            ),
            public_key_b64: URL_SAFE_NO_PAD.encode(public.as_bytes()),
            secret_key_b64: URL_SAFE_NO_PAD.encode(secret.to_bytes()),
            created_at: Utc::now(),
        }
    }

    pub fn signing_key(&self) -> Result<SigningKey, AppError> {
        Ok(SigningKey::from_bytes(&decode_32(
            &self.secret_key_b64,
            "Bridge client signing key",
        )?))
    }

    pub fn verifying_key(&self) -> Result<VerifyingKey, AppError> {
        let bytes = decode_32(&self.public_key_b64, "Bridge client public key")?;
        VerifyingKey::from_bytes(&bytes)
            .map_err(|_| AppError::message("Bridge client public key is invalid"))
    }

    pub fn sign_challenge(&self, nonce: &[u8]) -> Result<String, AppError> {
        Ok(URL_SAFE_NO_PAD.encode(self.signing_key()?.sign(nonce).to_bytes()))
    }
}

pub fn verify_device_challenge(
    public_key_b64: &str,
    nonce: &[u8],
    signature_b64: &str,
) -> Result<(), AppError> {
    let public = decode_32(public_key_b64, "Bridge device public key")?;
    let public = VerifyingKey::from_bytes(&public)
        .map_err(|_| AppError::message("Bridge device public key is invalid"))?;
    let signature: [u8; 64] = URL_SAFE_NO_PAD
        .decode(signature_b64)
        .map_err(|_| AppError::message("Bridge device signature is not valid base64url"))?
        .try_into()
        .map_err(|_| AppError::message("Bridge device signature must contain 64 bytes"))?;
    public
        .verify(nonce, &Signature::from_bytes(&signature))
        .map_err(|_| AppError::message("Bridge device signature did not verify"))
}

pub fn validate_device_public_key(value: &str) -> Result<(), AppError> {
    let public = decode_32(value, "Bridge device public key")?;
    VerifyingKey::from_bytes(&public)
        .map(|_| ())
        .map_err(|_| AppError::message("Bridge device public key is invalid"))
}

#[derive(Clone)]
pub struct BridgeIdentityStore {
    dir: PathBuf,
}

impl BridgeIdentityStore {
    pub fn at_default_path() -> Self {
        Self {
            dir: crate::core::paths::bridge_config_dir(),
        }
    }

    #[cfg(test)]
    pub fn at_path(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn load_or_create(&self) -> Result<BridgeIdentity, AppError> {
        let path = self.dir.join(IDENTITY_FILE);
        if path.is_file() {
            return read_json(&path);
        }

        let identity = BridgeIdentity::create();
        write_private_json(&path, &identity)?;
        Ok(identity)
    }

    pub fn reset(&self) -> Result<BridgeIdentity, AppError> {
        let identity = BridgeIdentity::create();
        write_private_json(&self.dir.join(IDENTITY_FILE), &identity)?;
        Ok(identity)
    }
}

#[derive(Clone)]
pub struct BridgeDeviceStore {
    dir: PathBuf,
}

impl BridgeDeviceStore {
    pub fn at_default_path() -> Self {
        Self {
            dir: crate::core::paths::bridge_config_dir(),
        }
    }

    #[cfg(test)]
    pub fn at_path(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn list(&self) -> Result<Vec<BridgeDevice>, AppError> {
        let path = self.dir.join(DEVICES_FILE);
        if !path.is_file() {
            return Ok(Vec::new());
        }
        read_json(&path)
    }

    pub fn upsert(&self, device: BridgeDevice) -> Result<(), AppError> {
        let mut devices = self.list()?;
        if let Some(existing) = devices
            .iter_mut()
            .find(|candidate| candidate.device_id == device.device_id)
        {
            *existing = device;
        } else {
            devices.push(device);
        }
        write_private_json(&self.dir.join(DEVICES_FILE), &devices)
    }

    pub fn revoke(&self, device_id: &str) -> Result<bool, AppError> {
        let mut devices = self.list()?;
        let Some(device) = devices
            .iter_mut()
            .find(|candidate| candidate.device_id == device_id)
        else {
            return Ok(false);
        };
        device.revoked = true;
        write_private_json(&self.dir.join(DEVICES_FILE), &devices)?;
        Ok(true)
    }

    pub fn mark_seen(&self, device_id: &str) -> Result<bool, AppError> {
        let mut devices = self.list()?;
        let Some(device) = devices
            .iter_mut()
            .find(|candidate| candidate.device_id == device_id && !candidate.revoked)
        else {
            return Ok(false);
        };
        device.last_seen_at = Some(Utc::now());
        write_private_json(&self.dir.join(DEVICES_FILE), &devices)?;
        Ok(true)
    }
}

#[derive(Clone)]
pub struct BridgeClientIdentityStore {
    dir: PathBuf,
}

impl BridgeClientIdentityStore {
    pub fn at_default_path() -> Self {
        Self {
            dir: crate::core::paths::bridge_config_dir(),
        }
    }

    #[cfg(test)]
    pub fn at_path(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn load_or_create(&self) -> Result<BridgeClientIdentity, AppError> {
        #[cfg(target_os = "ios")]
        {
            if let Some(identity) = load_ios_client_identity()? {
                Ok(identity)
            } else if let Some(identity) = self.load_legacy_identity()? {
                save_ios_client_identity(&identity)?;
                let _ = fs::remove_file(self.dir.join(CLIENT_IDENTITY_FILE));
                Ok(identity)
            } else {
                let identity = BridgeClientIdentity::create();
                save_ios_client_identity(&identity)?;
                Ok(identity)
            }
        }

        #[cfg(not(target_os = "ios"))]
        self.load_or_create_file()
    }

    fn load_legacy_identity(&self) -> Result<Option<BridgeClientIdentity>, AppError> {
        let path = self.dir.join(CLIENT_IDENTITY_FILE);
        if path.is_file() {
            let identity: BridgeClientIdentity = read_json(&path)?;
            return Ok(valid_client_identity(identity));
        }
        Ok(None)
    }

    #[cfg(not(target_os = "ios"))]
    fn load_or_create_file(&self) -> Result<BridgeClientIdentity, AppError> {
        if let Some(identity) = self.load_legacy_identity()? {
            return Ok(identity);
        }
        let identity = BridgeClientIdentity::create();
        write_private_json(&self.dir.join(CLIENT_IDENTITY_FILE), &identity)?;
        Ok(identity)
    }
}

fn valid_client_identity(identity: BridgeClientIdentity) -> Option<BridgeClientIdentity> {
    (identity.v >= 2
        && identity
            .signing_key()
            .map(|key| key.verifying_key().to_bytes())
            .ok()
            == identity.verifying_key().map(|key| key.to_bytes()).ok())
    .then_some(identity)
}

#[cfg(target_os = "ios")]
fn load_ios_client_identity() -> Result<Option<BridgeClientIdentity>, AppError> {
    use security_framework::passwords::get_generic_password;
    use security_framework_sys::base::errSecItemNotFound;

    match get_generic_password(IOS_KEYCHAIN_SERVICE, IOS_KEYCHAIN_ACCOUNT) {
        Ok(raw) => {
            let identity: BridgeClientIdentity = serde_json::from_slice(&raw)?;
            valid_client_identity(identity)
                .map(Some)
                .ok_or_else(|| AppError::message("iOS Keychain bridge identity is invalid"))
        }
        Err(error) if error.code() == errSecItemNotFound => Ok(None),
        Err(error) => Err(AppError::message(format!(
            "Could not read the iOS Keychain bridge identity: {error}"
        ))),
    }
}

#[cfg(target_os = "ios")]
fn save_ios_client_identity(identity: &BridgeClientIdentity) -> Result<(), AppError> {
    use security_framework::passwords::set_generic_password;

    let raw = serde_json::to_vec(identity)?;
    set_generic_password(IOS_KEYCHAIN_SERVICE, IOS_KEYCHAIN_ACCOUNT, &raw).map_err(|error| {
        AppError::message(format!(
            "Could not save the iOS Keychain bridge identity: {error}"
        ))
    })
}

#[derive(Clone)]
pub struct BridgeClientProfileStore {
    dir: PathBuf,
}

impl BridgeClientProfileStore {
    pub fn at_default_path() -> Self {
        Self {
            dir: crate::core::paths::bridge_config_dir(),
        }
    }

    #[cfg(test)]
    pub fn at_path(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn load(&self) -> Result<Option<BridgeClientProfile>, AppError> {
        let path = self.dir.join(CLIENT_PROFILE_FILE);
        if !path.is_file() {
            return Ok(None);
        }
        read_json(&path).map(Some)
    }

    pub fn save(&self, profile: &BridgeClientProfile) -> Result<(), AppError> {
        write_private_json(&self.dir.join(CLIENT_PROFILE_FILE), profile)
    }

    pub fn mark_paired(&self) -> Result<(), AppError> {
        let Some(mut profile) = self.load()? else {
            return Err(AppError::message("Bridge connection profile is missing"));
        };
        profile.paired = true;
        self.save(&profile)
    }
}

fn decode_32(value: &str, label: &str) -> Result<[u8; 32], AppError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::message(format!("{label} is not valid base64url")))?;
    bytes
        .try_into()
        .map_err(|_| AppError::message(format!("{label} must contain 32 bytes")))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, AppError> {
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw).map_err(AppError::from)
}

fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::message("Bridge config path has no parent"))?;
    fs::create_dir_all(parent)?;
    let raw = serde_json::to_vec_pretty(value)?;
    fs::write(path, raw)?;

    // iOS owns the app container and may reject chmod even for files created
    // by the app. The container already provides the required isolation;
    // keep explicit 0600 hardening for desktop Unix targets.
    #[cfg(all(unix, not(target_os = "ios")))]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("agentero-bridge-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn identity_is_stable_after_its_first_creation() {
        let dir = test_dir();
        let store = BridgeIdentityStore::at_path(dir.clone());
        let first = store.load_or_create().expect("create identity");
        let second = store.load_or_create().expect("load identity");

        assert_eq!(first, second);
        assert!(first.server_id.starts_with("agt_"));
        assert_eq!(
            first.public_key().expect("public key"),
            first.secret_key().expect("secret key").public_key()
        );

        fs::remove_dir_all(dir).expect("clean test directory");
    }

    #[test]
    fn device_registry_can_revoke_a_single_device() {
        let dir = test_dir();
        let store = BridgeDeviceStore::at_path(dir.clone());
        let device = BridgeDevice {
            device_id: "ios_1".to_string(),
            name: "Phil's iPhone".to_string(),
            public_key_b64: URL_SAFE_NO_PAD.encode([7_u8; 32]),
            paired_at: Utc::now(),
            last_seen_at: None,
            revoked: false,
        };
        store.upsert(device).expect("store device");

        assert!(store.revoke("ios_1").expect("revoke device"));
        assert!(store.list().expect("list devices")[0].revoked);

        fs::remove_dir_all(dir).expect("clean test directory");
    }

    #[test]
    fn client_identity_signs_a_challenge() {
        let identity = BridgeClientIdentity::create();
        let nonce = b"relay-connection-nonce";
        let signature = identity.sign_challenge(nonce).expect("sign challenge");
        verify_device_challenge(&identity.public_key_b64, nonce, &signature)
            .expect("verify challenge");
        assert!(verify_device_challenge(&identity.public_key_b64, b"wrong", &signature).is_err());
        assert_eq!(
            identity
                .verifying_key()
                .expect("valid public key")
                .to_bytes(),
            identity
                .signing_key()
                .expect("valid private key")
                .verifying_key()
                .to_bytes()
        );
    }

    #[test]
    fn old_client_identity_is_replaced_before_pairing() {
        let dir = test_dir();
        let store = BridgeClientIdentityStore::at_path(dir.clone());
        let old = BridgeClientIdentity {
            v: 1,
            device_id: "ios_old".to_string(),
            public_key_b64: URL_SAFE_NO_PAD.encode([1_u8; 32]),
            secret_key_b64: URL_SAFE_NO_PAD.encode([2_u8; 32]),
            created_at: Utc::now(),
        };
        write_private_json(&dir.join(CLIENT_IDENTITY_FILE), &old).expect("write old identity");

        let current = store.load_or_create().expect("replace old identity");
        assert_eq!(current.v, 2);
        assert_ne!(current.device_id, old.device_id);
        assert_eq!(
            current
                .signing_key()
                .expect("signing key")
                .verifying_key()
                .to_bytes(),
            current.verifying_key().expect("verifying key").to_bytes()
        );

        fs::remove_dir_all(dir).expect("clean test directory");
    }

    #[test]
    fn client_profile_persists_pairing_state() {
        let dir = test_dir();
        let store = BridgeClientProfileStore::at_path(dir.clone());
        store
            .save(&BridgeClientProfile {
                offer_url: "agentero://pair#offer=example".to_string(),
                device_name: "iPhone".to_string(),
                paired: false,
            })
            .expect("save profile");
        store.mark_paired().expect("mark profile paired");
        assert!(store.load().expect("load profile").expect("profile").paired);
        fs::remove_dir_all(dir).expect("clean test directory");
    }
}
