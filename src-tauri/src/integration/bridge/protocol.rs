use crate::core::error::AppError;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use url::Url;

pub const RELAY_PROTOCOL_VERSION: u8 = 2;
pub const DEFAULT_RELAY_ENDPOINT: &str = "relay.philfan.cn:443";

/// Relay connection information embedded in a pairing offer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayOffer {
    pub endpoint: String,
}

/// QR payload. It intentionally carries no bearer token: desktop confirmation
/// and a device signature turn a scanned offer into an approved pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOffer {
    pub v: u8,
    pub server_id: String,
    pub host_public_key_b64: String,
    pub relay: RelayOffer,
    pub host_name: String,
    #[serde(default)]
    pub pin: bool,
}

impl BridgeOffer {
    pub fn to_pair_url(&self) -> Result<Url, AppError> {
        let raw = serde_json::to_vec(self)?;
        Url::parse(&format!(
            "agentero://pair#offer={}",
            URL_SAFE_NO_PAD.encode(raw)
        ))
        .map_err(|error| AppError::message(format!("invalid pair URL: {error}")))
    }

    pub fn from_pair_url(value: &str) -> Result<Self, AppError> {
        let url = Url::parse(value)
            .map_err(|error| AppError::message(format!("invalid pairing URL: {error}")))?;
        if url.scheme() != "agentero" || url.host_str() != Some("pair") {
            return Err(AppError::message("pairing URL must use agentero://pair"));
        }
        let offer = url
            .fragment()
            .and_then(|fragment| fragment.strip_prefix("offer="))
            .ok_or_else(|| AppError::message("pairing URL is missing offer"))?;
        let raw = URL_SAFE_NO_PAD
            .decode(offer)
            .map_err(|_| AppError::message("pairing offer is not valid base64url"))?;
        let parsed: Self = serde_json::from_slice(&raw)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> Result<(), AppError> {
        if self.v != 1 {
            return Err(AppError::message("unsupported pairing offer version"));
        }
        if !self.server_id.starts_with("agt_") || self.server_id.len() < 10 {
            return Err(AppError::message("pairing offer has an invalid server ID"));
        }
        let key = URL_SAFE_NO_PAD
            .decode(&self.host_public_key_b64)
            .map_err(|_| AppError::message("pairing offer has an invalid host key"))?;
        if key.len() != 32 {
            return Err(AppError::message(
                "pairing offer host key must contain 32 bytes",
            ));
        }
        RelayEndpoint::parse(&self.relay.endpoint)?;
        if self.host_name.trim().is_empty() {
            return Err(AppError::message("pairing offer is missing host name"));
        }
        Ok(())
    }
}

/// Validates the endpoint form in a QR offer and derives the Relay WebSocket URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayEndpoint(Url);

impl RelayEndpoint {
    pub fn parse(value: &str) -> Result<Self, AppError> {
        let endpoint = value.trim();
        if endpoint.is_empty() || endpoint.chars().any(char::is_whitespace) {
            return Err(AppError::message("Relay endpoint is required"));
        }
        let raw = if endpoint.contains("://") {
            endpoint.to_string()
        } else {
            format!("wss://{endpoint}")
        };
        let mut url = Url::parse(&raw)
            .map_err(|error| AppError::message(format!("invalid Relay endpoint: {error}")))?;
        if !matches!(url.scheme(), "ws" | "wss") || url.host_str().is_none() {
            return Err(AppError::message(
                "Relay endpoint must be a ws:// or wss:// URL",
            ));
        }
        if url.path().is_empty() || url.path() == "/" {
            url.set_path("/ws");
        }
        if url.path() != "/ws" || url.query().is_some() || url.fragment().is_some() {
            return Err(AppError::message(
                "Relay endpoint must not include a path, query, or fragment",
            ));
        }
        Ok(Self(url))
    }

    pub fn websocket_url(&self) -> &Url {
        &self.0
    }

    pub fn connection_url(
        &self,
        server_id: &str,
        role: &str,
        connection_id: Option<&str>,
    ) -> Result<Url, AppError> {
        if !matches!(role, "server" | "client") {
            return Err(AppError::message("invalid Relay role"));
        }
        let mut url = self.0.clone();
        let mut query = url.query_pairs_mut();
        query.append_pair("v", &RELAY_PROTOCOL_VERSION.to_string());
        query.append_pair("serverId", server_id);
        query.append_pair("role", role);
        if let Some(connection_id) = connection_id {
            query.append_pair("connectionId", connection_id);
        }
        drop(query);
        Ok(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer() -> BridgeOffer {
        BridgeOffer {
            v: 1,
            server_id: "agt_abcdefghijk".to_string(),
            host_public_key_b64: URL_SAFE_NO_PAD.encode([1_u8; 32]),
            relay: RelayOffer {
                endpoint: DEFAULT_RELAY_ENDPOINT.to_string(),
            },
            host_name: "Research Mac".to_string(),
            pin: false,
        }
    }

    #[test]
    fn pairing_offer_round_trips_through_an_agentero_url() {
        let original = offer();
        let url = original.to_pair_url().expect("encode offer");
        assert_eq!(
            BridgeOffer::from_pair_url(url.as_str()).expect("decode offer"),
            original
        );
    }

    #[test]
    fn relay_endpoint_builds_the_paseo_v2_client_url() {
        let endpoint = RelayEndpoint::parse(DEFAULT_RELAY_ENDPOINT).expect("parse endpoint");
        assert_eq!(
            endpoint.websocket_url().as_str(),
            "wss://relay.philfan.cn/ws"
        );
        assert_eq!(
            endpoint
                .connection_url("agt_abcdefghijk", "client", None)
                .expect("client url")
                .as_str(),
            "wss://relay.philfan.cn/ws?v=2&serverId=agt_abcdefghijk&role=client"
        );
    }

    #[test]
    fn relay_endpoint_rejects_unexpected_paths() {
        assert!(RelayEndpoint::parse("relay.philfan.cn:443/other").is_err());
    }
}
