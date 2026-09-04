use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Plaintext messages permitted on a Relay data channel before encryption.
/// After `E2eeReady`, every application message must be a binary encrypted frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum E2eeHandshake {
    E2eeHello { key: String },
    E2eeReady,
}

/// Relay control messages are not application requests. They only instruct the
/// Host to open or close a data channel for a Relay-provided connection ID.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayControlMessage {
    Sync {
        #[serde(rename = "connectionIds")]
        connection_ids: Vec<String>,
    },
    Connected {
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
    Disconnected {
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
    Pong {
        ts: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

/// Encrypted Bridge application protocol. The message names deliberately stay
/// small and transport-neutral so an iOS app can use the same Rust type through
/// Tauri commands while the desktop Host dispatches to its domain functions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeMessage {
    Hello {
        device_id: String,
        protocol_version: u8,
        app_version: String,
    },
    ServerInfo {
        server_id: String,
        host_name: String,
        app_version: String,
        vault_name: Option<String>,
    },
    PairRequest {
        request_id: String,
        device_id: String,
        device_name: String,
        device_public_key_b64: String,
    },
    PairPending {
        request_id: String,
        verification_code: String,
    },
    PairOk {
        request_id: String,
    },
    PairDenied {
        request_id: String,
        reason: String,
    },
    DeviceChallenge {
        nonce_b64: String,
    },
    DeviceProof {
        signature_b64: String,
    },
    Ping {
        ts: i64,
    },
    Pong {
        ts: i64,
    },
    Rpc {
        id: String,
        method: String,
        params: Value,
    },
    RpcResult {
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    Event {
        name: String,
        payload: Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_control_message_uses_the_v2_wire_fields() {
        let message: RelayControlMessage =
            serde_json::from_str(r#"{"type":"connected","connectionId":"clt_123"}"#)
                .expect("parse Relay control message");
        assert_eq!(
            message,
            RelayControlMessage::Connected {
                connection_id: "clt_123".to_string()
            }
        );
    }

    #[test]
    fn rpc_result_omits_empty_optional_payloads() {
        let message = BridgeMessage::RpcResult {
            id: "req_1".to_string(),
            ok: true,
            data: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(message).expect("serialize message"),
            serde_json::json!({"type":"rpc_result","id":"req_1","ok":true})
        );
    }
}
