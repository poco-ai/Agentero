import { describe, expect, it } from "vitest";
import { VoiceStartGate } from "@/lib/voice-defense/start-gate";

function leaseBox() {
	let held: string | null = null;
	return {
		get held() {
			return held;
		},
		acquire(leaseId: string) {
			if (held) return false;
			held = leaseId;
			return true;
		},
		release(leaseId: string) {
			if (held === leaseId) held = null;
		},
		sessionActive() {
			return held !== null;
		},
	};
}

describe("voice start gate", () => {
	it("acquires a lease and issues a new operation id", () => {
		const leases = leaseBox();
		const gate = new VoiceStartGate();
		const operation = gate.begin({
			open: true,
			hasClient: false,
			sessionActive: leases.sessionActive(),
			acquire: (leaseId) => leases.acquire(leaseId),
			nextLeaseId: () => "lease-1",
		});

		expect(operation).toBe(1);
		expect(gate.leaseId).toBe("lease-1");
		expect(gate.isStarting).toBe(true);
		expect(gate.isCurrent(1, true)).toBe(true);
		expect(leases.held).toBe("lease-1");
	});

	it("rejects a second start while one is in flight", () => {
		const leases = leaseBox();
		const gate = new VoiceStartGate();
		const first = gate.begin({
			open: true,
			hasClient: false,
			sessionActive: false,
			acquire: (leaseId) => leases.acquire(leaseId),
			nextLeaseId: () => "lease-1",
		});
		const second = gate.begin({
			open: true,
			hasClient: false,
			sessionActive: leases.sessionActive(),
			acquire: (leaseId) => leases.acquire(leaseId),
			nextLeaseId: () => "lease-2",
		});

		expect(first).toBe(1);
		expect(second).toBeNull();
		expect(gate.leaseId).toBe("lease-1");
	});

	it("rejects starts when the dialog is closed, a client exists, or a session is live", () => {
		const gate = new VoiceStartGate();
		expect(
			gate.begin({
				open: false,
				hasClient: false,
				sessionActive: false,
				acquire: () => true,
				nextLeaseId: () => "lease-1",
			}),
		).toBeNull();
		expect(
			gate.begin({
				open: true,
				hasClient: true,
				sessionActive: false,
				acquire: () => true,
				nextLeaseId: () => "lease-1",
			}),
		).toBeNull();
		expect(
			gate.begin({
				open: true,
				hasClient: false,
				sessionActive: true,
				acquire: () => true,
				nextLeaseId: () => "lease-1",
			}),
		).toBeNull();
		expect(gate.currentOperation).toBe(0);
	});

	it("returns the lease to drop when a failed start has no client", () => {
		const leases = leaseBox();
		const gate = new VoiceStartGate();
		const operation = gate.begin({
			open: true,
			hasClient: false,
			sessionActive: false,
			acquire: (leaseId) => leases.acquire(leaseId),
			nextLeaseId: () => "lease-1",
		});

		expect(gate.release(operation ?? 0, false)).toBe("lease-1");
		expect(gate.leaseId).toBeNull();
		expect(gate.isStarting).toBe(false);
		expect(gate.isCurrent(operation ?? 0, true)).toBe(false);
	});

	it("keeps the lease after connect and ignores stale releases", () => {
		const leases = leaseBox();
		const gate = new VoiceStartGate();
		const operation = gate.begin({
			open: true,
			hasClient: false,
			sessionActive: false,
			acquire: (leaseId) => leases.acquire(leaseId),
			nextLeaseId: () => "lease-1",
		});
		gate.markConnected();

		expect(gate.release(operation ?? 0, true)).toBeNull();
		expect(gate.leaseId).toBe("lease-1");
		expect(gate.release(99, false)).toBeNull();
		expect(gate.leaseId).toBe("lease-1");
	});

	it("invalidates in-flight work and drops an unused lease", () => {
		const leases = leaseBox();
		const gate = new VoiceStartGate();
		const operation = gate.begin({
			open: true,
			hasClient: false,
			sessionActive: false,
			acquire: (leaseId) => leases.acquire(leaseId),
			nextLeaseId: () => "lease-1",
		});

		expect(gate.invalidate(false)).toBe("lease-1");
		expect(gate.isCurrent(operation ?? 0, true)).toBe(false);
		expect(gate.currentOperation).toBe(2);
		expect(gate.leaseId).toBeNull();
	});

	it("does not treat a closed dialog as the current start", () => {
		const gate = new VoiceStartGate();
		gate.begin({
			open: true,
			hasClient: false,
			sessionActive: false,
			acquire: () => true,
			nextLeaseId: () => "lease-1",
		});
		expect(gate.isCurrent(1, false)).toBe(false);
	});
});
