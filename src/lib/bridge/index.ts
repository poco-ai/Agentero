export {
	type BridgeClientStatus,
	bridgeConnect,
	bridgeDisconnect,
	bridgeResume,
	bridgeRpc,
	bridgeStatus,
	listenBridgeEvent,
	listenBridgeProgress,
	listenBridgeStatus,
	listenPairPending,
	type PairPendingEvent,
} from "@/lib/bridge/client";
export {
	type BridgeDevice,
	type BridgeStatus,
	bridgeDevices,
	bridgeHostStatus,
	bridgeOffer,
	bridgeRespondToPairing,
	bridgeRevokeDevice,
	bridgeStart,
	bridgeStop,
	listenHostStatus,
	listenPairingRequest,
	type PairingRequest,
} from "@/lib/bridge/host";
export { loadBridgePaperPdf } from "@/lib/bridge/pdf";
// file-cache is an internal transfer cache; not part of the public bridge API.
