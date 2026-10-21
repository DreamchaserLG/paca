// Per-conversation delivery of agent.* events.
//
// The `conversations` room only holds sockets whose account may read
// conversations project-wide. IAM policies can still exclude one
// conversation from such an account (for instance by its environment), and
// the REST routes honour that, so an event is delivered to a socket only
// after the API confirms that account can read that conversation. Answers
// are cached briefly per account + conversation, so a streamed reply costs
// one API call per viewer, not one per token.

import type { DefaultEventsMap, RemoteSocket } from "socket.io";
import { ApiRequestError, canReadConversation } from "./api-client.ts";

const DEFAULT_TTL_MS = 30_000;
const SWEEP_THRESHOLD = 10_000;

interface Entry {
	expires: number;
	allowed: Promise<boolean>;
}

export interface ConversationViewer {
	userId: string;
	rawToken: string;
}

export class ConversationAccess {
	private readonly cache = new Map<string, Entry>();

	constructor(
		private readonly apiUrl: string,
		private readonly ttlMs = DEFAULT_TTL_MS,
		private readonly check: typeof canReadConversation = canReadConversation,
	) {}

	// canRead resolves true only on a positive answer; API failures are not
	// cached, so the next event retries. A failure rejects so the caller can
	// log it and fail closed.
	canRead(
		viewer: ConversationViewer,
		projectId: string,
		conversationId: string,
	): Promise<boolean> {
		const key = `${viewer.userId}:${conversationId}`;
		const now = Date.now();
		const hit = this.cache.get(key);
		if (hit && hit.expires > now) return hit.allowed;

		if (this.cache.size >= SWEEP_THRESHOLD) {
			for (const [k, e] of this.cache) {
				if (e.expires <= now) this.cache.delete(k);
			}
		}
		const allowed = this.check(
			this.apiUrl,
			viewer.rawToken,
			projectId,
			conversationId,
		);
		const entry = { expires: now + this.ttlMs, allowed };
		this.cache.set(key, entry);
		allowed.catch(() => {
			if (this.cache.get(key) === entry) this.cache.delete(key);
		});
		return allowed;
	}
}

// ConversationQueue runs jobs for the same conversation one after another, so
// events keep their order even when an earlier one waits on an access check.
export class ConversationQueue {
	private readonly tails = new Map<string, Promise<void>>();

	run(conversationId: string, job: () => Promise<void>): void {
		const prev = this.tails.get(conversationId) ?? Promise.resolve();
		const next = prev.then(job, job).then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(conversationId, next);
		void next.then(() => {
			if (this.tails.get(conversationId) === next) {
				this.tails.delete(conversationId);
			}
		});
	}
}

// deliverToConversationReaders emits the event to each socket of `sockets`
// that may read the conversation. A socket whose token the API rejects (401)
// is disconnected so it reconnects with a fresh one; any other failure skips
// that socket for this event.
export async function deliverToConversationReaders(
	sockets: RemoteSocket<DefaultEventsMap, ConversationViewer>[],
	access: ConversationAccess,
	projectId: string,
	conversationId: string,
	event: { type: string; payload: Record<string, unknown> },
	onError: (err: unknown, userId: string) => void,
): Promise<void> {
	await Promise.all(
		sockets.map(async (s) => {
			try {
				if (await access.canRead(s.data, projectId, conversationId)) {
					s.emit("event", event);
				}
			} catch (err) {
				onError(err, s.data.userId);
				if (err instanceof ApiRequestError && err.status === 401) {
					s.disconnect(true);
				}
			}
		}),
	);
}
