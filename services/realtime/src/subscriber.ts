// Valkey Pub/Sub subscriber.
//
// The API publishes every real-time event to the "paca.events" channel as
// JSON-serialised messages with the shape:
//
//   { "type": "<event-type>", "payload": { ...event-specific fields... } }
//
// Routing
// -------
// Events are routed to namespace-scoped Socket.IO rooms:
//
//   task.*     events  →  project:<projectId>:tasks
//   doc.*      events  →  project:<projectId>:docs
//   workflow.* events  →  project:<projectId>:workflows (except
//                          workflow.assigned, which is task-scoped)
//   sprint.*   events  →  project:<projectId>:sprints
//   environment.* events → project:<projectId>:environments
//   agent.*    events  →  the sockets of project:<projectId>:conversations
//                          that the API confirms can read that conversation
//                          (see conversation-access.ts); a payload-free
//                          agent.session.started also goes to the tasks room;
//                          agent.acp_bridge.status goes to the tasks room. OR —
//                          when the event has
//                          no project_id (a global agent's home-page / admin
//                          chat, see services/ai-agent's
//                          core.streams.publish_realtime) —
//                          user:<actorAccountId>:agent-chat instead.
//
// Sockets are pre-placed in the correct rooms at join time based on their
// project permissions (project:* rooms) or simply their own identity
// (user:<userId>:notifications and user:<userId>:agent-chat, auto-joined on
// connect — see server.ts).  No per-message permission checks are needed
// here — if a socket is in the room it is authorised to receive the event.
//
// Events without a project_id and (for agent.* events) without an
// actor_account_id, or with an unrecognised type prefix, are dropped.

import Redis from "ioredis";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import {
	ConversationAccess,
	ConversationQueue,
	deliverToConversationReaders,
} from "./conversation-access.ts";
import {
	agentChatRoomName,
	eventNamespace,
	projectRoomName,
} from "./permissions.ts";

// CHANNEL is the Valkey Pub/Sub channel the API publishes to.
// Must stay in sync with events.ChannelRealtime in services/api.
const CHANNEL = "paca.events";

interface RealtimeMessage {
	type: string;
	payload?: unknown;
	data?: unknown;
}

// createSubscriber connects a dedicated ioredis client in subscriber mode,
// subscribes to CHANNEL, and wires incoming messages to Socket.IO rooms.
// Returns the ioredis client so the caller can disconnect it on shutdown.
export function createSubscriber(
	valkeyUrl: string,
	io: Server,
	logger: Logger,
	apiUrl: string,
): Redis {
	const conversations: ConversationRouting = {
		access: new ConversationAccess(apiUrl),
		queue: new ConversationQueue(),
	};
	// A separate client is required because ioredis clients in subscriber mode
	// cannot issue regular commands.
	const client = new Redis(valkeyUrl, {
		autoResubscribe: true,
		lazyConnect: false,
		maxRetriesPerRequest: null,
	});

	client.on("connect", () => {
		logger.info("valkey subscriber connected");
	});

	client.on("reconnecting", () => {
		logger.warn("valkey subscriber reconnecting");
	});

	client.on("error", (err: unknown) => {
		logger.error({ err }, "valkey subscriber error");
	});

	client.subscribe(CHANNEL, (err, count) => {
		if (err) {
			logger.error({ err }, `failed to subscribe to ${CHANNEL}`);
		} else {
			logger.info(
				{ channel: CHANNEL, subscriptions: count },
				"subscribed to valkey channel",
			);
		}
	});

	client.on("message", (_channel: string, raw: string) => {
		let msg: RealtimeMessage;
		try {
			msg = JSON.parse(raw) as RealtimeMessage;
		} catch (err) {
			logger.warn({ err, raw }, "failed to parse valkey message — skipping");
			return;
		}

		routeEvent(io, msg, logger, conversations);
	});

	return client;
}

interface ConversationRouting {
	access: ConversationAccess;
	queue: ConversationQueue;
}

function routeEvent(
	io: Server,
	msg: RealtimeMessage,
	logger: Logger,
	conversations: ConversationRouting,
): void {
	const { type } = msg;
	const payload = eventPayload(msg);
	if (!payload) {
		logger.debug({ type }, "event has no payload — skipped");
		return;
	}

	// notification.* events are routed to a user-specific room.
	if (type.startsWith("notification.")) {
		const recipientAccountId = payload.recipient_account_id;
		if (typeof recipientAccountId !== "string" || !recipientAccountId) {
			logger.debug(
				{ type },
				"notification event has no recipient_account_id — skipped",
			);
			return;
		}
		const room = `user:${recipientAccountId}:notifications`;
		logger.debug({ type, room }, "routing notification to user room");
		io.to(room).emit("notification", { type, payload });
		return;
	}

	// An owner-private agent.* event carries actor_account_id (the owning user)
	// and routes to that user's own per-user room — this covers both global
	// chat and a project's owner-private chat conversations. Checked before
	// project_id so a private conversation is never also broadcast into the
	// project room; a project-shared conversation has no actor_account_id and
	// falls through to the project-scoped branch below.
	if (type.startsWith("agent.")) {
		const actorAccountId = payload.actor_account_id;
		if (typeof actorAccountId === "string" && actorAccountId) {
			const room = agentChatRoomName(actorAccountId);
			logger.debug(
				{ type, room },
				"routing owner-private agent event to user room",
			);
			io.to(room).emit("event", { type, payload });
			return;
		}
	}

	// Project-scoped events (project-shared conversations, tasks, docs, ...).
	const projectId = payload.project_id;
	if (typeof projectId === "string" && projectId) {
		// Conversation content is authorized per conversation, not per room.
		const conversationId = payload.conversation_id;
		if (
			type.startsWith("agent.") &&
			type !== "agent.acp_bridge.status" &&
			typeof conversationId === "string" &&
			conversationId
		) {
			routeConversationEvent(
				io,
				{ type, payload },
				projectId,
				conversationId,
				logger,
				conversations,
			);
			return;
		}

		// Resolve the namespace room from the event type prefix.
		const ns = eventNamespace(type);
		if (!ns) {
			logger.debug({ type }, "unknown event namespace — skipped");
			return;
		}

		const room = projectRoomName(projectId, ns);
		logger.debug({ type, room }, "routing event to room");
		io.to(room).emit("event", { type, payload });
		return;
	}

	logger.debug({ type }, "event has no project or actor scope — skipped");
}

// routeConversationEvent delivers an agent.* conversation event to the sockets
// in the project's conversations room that may read this conversation. Events
// of one conversation are delivered in order.
function routeConversationEvent(
	io: Server,
	event: { type: string; payload: Record<string, unknown> },
	projectId: string,
	conversationId: string,
	logger: Logger,
	{ access, queue }: ConversationRouting,
): void {
	// Task boards refresh on a conversation starting. The task-room copy
	// carries no conversation content, only which conversation it was.
	if (event.type === "agent.session.started") {
		io.to(projectRoomName(projectId, "tasks")).emit("event", {
			type: event.type,
			payload: { project_id: projectId, conversation_id: conversationId },
		});
	}

	const room = projectRoomName(projectId, "conversations");
	queue.run(conversationId, async () => {
		const sockets = await io.in(room).fetchSockets();
		await deliverToConversationReaders(
			sockets,
			access,
			projectId,
			conversationId,
			event,
			(err, userId) =>
				logger.warn(
					{ type: event.type, conversationId, userId, err },
					"conversation access check failed — event not delivered",
				),
		);
	});
}

function eventPayload(msg: RealtimeMessage): Record<string, unknown> | null {
	if (msg.payload && typeof msg.payload === "object") {
		return msg.payload as Record<string, unknown>;
	}
	if (msg.data && typeof msg.data === "object") {
		return msg.data as Record<string, unknown>;
	}
	return null;
}
