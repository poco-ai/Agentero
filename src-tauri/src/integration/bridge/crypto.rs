use crate::core::error::AppError;
use crypto_box::aead::{Aead, AeadCore, OsRng};
use crypto_box::{PublicKey, SalsaBox, SecretKey};

const NONCE_BYTES: usize = 24;

/// Encrypts and decrypts one Bridge data-channel frame.
///
/// The frame format is `[24-byte nonce][XSalsa20-Poly1305 ciphertext]`. Relay
/// routing is deliberately outside this type and therefore never receives the
/// plaintext or either endpoint's long-term private key.
pub struct SessionCipher {
    cipher: SalsaBox,
}

impl SessionCipher {
    pub fn from_keys(local_secret: &SecretKey, remote_public: &PublicKey) -> Self {
        Self {
            cipher: SalsaBox::new(remote_public, local_secret),
        }
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext)
            .map_err(|_| AppError::message("Bridge frame encryption failed"))?;
        let mut frame = Vec::with_capacity(nonce.len() + ciphertext.len());
        frame.extend_from_slice(&nonce);
        frame.extend_from_slice(&ciphertext);
        Ok(frame)
    }

    pub fn decrypt(&self, frame: &[u8]) -> Result<Vec<u8>, AppError> {
        if frame.len() <= NONCE_BYTES {
            return Err(AppError::message("Bridge encrypted frame is too short"));
        }
        let (nonce, ciphertext) = frame.split_at(NONCE_BYTES);
        self.cipher
            .decrypt(nonce.into(), ciphertext)
            .map_err(|_| AppError::message("Bridge frame authentication failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_a_frame_that_only_the_other_endpoint_can_open() {
        let left = SecretKey::generate(&mut OsRng);
        let right = SecretKey::generate(&mut OsRng);
        let sender = SessionCipher::from_keys(&left, &right.public_key());
        let receiver = SessionCipher::from_keys(&right, &left.public_key());

        let encrypted = sender.encrypt(b"bridge rpc").expect("encrypt frame");
        assert_ne!(encrypted, b"bridge rpc");
        assert_eq!(
            receiver.decrypt(&encrypted).expect("decrypt frame"),
            b"bridge rpc"
        );
    }

    #[test]
    fn rejects_a_tampered_frame() {
        let left = SecretKey::generate(&mut OsRng);
        let right = SecretKey::generate(&mut OsRng);
        let sender = SessionCipher::from_keys(&left, &right.public_key());
        let receiver = SessionCipher::from_keys(&right, &left.public_key());
        let mut encrypted = sender.encrypt(b"bridge rpc").expect("encrypt frame");
        let last = encrypted.last_mut().expect("ciphertext is not empty");
        *last ^= 1;

        assert!(receiver.decrypt(&encrypted).is_err());
    }
}
