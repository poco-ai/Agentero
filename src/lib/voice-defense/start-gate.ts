/**
 * Serializes one Voice connect attempt against the global session lease.
 *
 * Stale async work is identified by a monotonically increasing operation id.
 * The React layer mirrors `starting` into UI state and releases the Host lease
 * when this gate returns a lease id to drop.
 */
export class VoiceStartGate {
	private operation = 0;
	private starting = false;
	leaseId: string | null = null;

	get currentOperation(): number {
		return this.operation;
	}

	get isStarting(): boolean {
		return this.starting;
	}

	begin(input: {
		open: boolean;
		hasClient: boolean;
		sessionActive: boolean;
		acquire: (leaseId: string) => boolean;
		/**
		 * Prepare-page enter may steal a lease held with no Voice client.
		 * A live client must still be rejected.
		 */
		takeoverStaleLease?: boolean;
		releaseStale?: () => void;
		nextLeaseId?: () => string;
	}): number | null {
		if (!input.open || this.starting || input.hasClient) {
			return null;
		}
		if (input.sessionActive) {
			if (!input.takeoverStaleLease) return null;
			input.releaseStale?.();
			this.leaseId = null;
		}
		const leaseId = input.nextLeaseId?.() ?? crypto.randomUUID();
		if (!input.acquire(leaseId)) return null;
		this.leaseId = leaseId;
		this.starting = true;
		this.operation += 1;
		return this.operation;
	}

	isCurrent(operation: number, open: boolean): boolean {
		return open && this.starting && this.operation === operation;
	}

	/**
	 * Clear the starting flag for this operation. Returns the lease to release
	 * when no client was attached.
	 */
	release(operation: number, hasClient: boolean): string | null {
		if (this.operation !== operation) return null;
		this.starting = false;
		if (hasClient) return null;
		return this.takeLease();
	}

	/**
	 * Abandon the in-flight start. Returns the lease to release when no client
	 * was attached.
	 */
	invalidate(hasClient: boolean): string | null {
		this.operation += 1;
		this.starting = false;
		if (hasClient) return null;
		return this.takeLease();
	}

	/** Connect succeeded: keep the lease, stop advertising "starting". */
	markConnected(): void {
		this.starting = false;
	}

	clearLeaseIf(leaseId: string | null): void {
		if (leaseId && this.leaseId === leaseId) this.leaseId = null;
	}

	private takeLease(): string | null {
		const leaseId = this.leaseId;
		this.leaseId = null;
		return leaseId;
	}
}
