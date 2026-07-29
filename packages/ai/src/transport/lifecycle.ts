import { postmortem } from "@oh-my-pi/pi-utils";

const disposers = new Map<string, () => Promise<void>>();
let disposalPromise: Promise<void> | undefined;
let disposed = false;
let registered = false;

export function registerTransportDisposer(name: string, dispose: () => Promise<void>): void {
	if (disposed || disposalPromise) {
		throw new Error(`Cannot register transport disposer ${name} during or after disposal`);
	}
	if (disposers.has(name)) {
		throw new Error(`Transport disposer already registered: ${name}`);
	}
	disposers.set(name, dispose);
	if (!registered) {
		postmortem.register("ai-transports", disposeTransports);
		registered = true;
	}
}

export function disposeTransports(): Promise<void> {
	if (disposalPromise) return disposalPromise;
	disposed = true;
	const pending = [...disposers.values()];
	disposers.clear();
	disposalPromise = Promise.allSettled(pending.map(dispose => dispose())).then(results => {
		const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (rejected) throw rejected.reason;
	});
	return disposalPromise;
}

export function isTransportDisposed(): boolean {
	return disposed;
}
