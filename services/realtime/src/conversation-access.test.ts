import { describe, expect, it } from "bun:test";

import { ApiRequestError } from "./api-client.ts";
import {
	ConversationAccess,
	ConversationQueue,
	deliverToConversationReaders,
} from "./conversation-access.ts";
import { eventNamespace } from "./permissions.ts";

const viewer = (userId: string) => ({ userId, rawToken: `tok-${userId}` });

describe("ConversationAccess", () => {
	it("asks the API once per account + conversation within the TTL", async () => {
		let calls = 0;
		const access = new ConversationAccess("http://api", 60_000, async () => {
			calls++;
			return true;
		});
		expect(await access.canRead(viewer("u1"), "p", "c1")).toBe(true);
		expect(await access.canRead(viewer("u1"), "p", "c1")).toBe(true);
		await access.canRead(viewer("u2"), "p", "c1");
		await access.canRead(viewer("u1"), "p", "c2");
		expect(calls).toBe(3);
	});

	it("does not cache a failed check", async () => {
		let calls = 0;
		const access = new ConversationAccess("http://api", 60_000, async () => {
			calls++;
			if (calls === 1) throw new ApiRequestError("boom", 500);
			return true;
		});
		await expect(access.canRead(viewer("u1"), "p", "c1")).rejects.toThrow();
		expect(await access.canRead(viewer("u1"), "p", "c1")).toBe(true);
		expect(calls).toBe(2);
	});
});

describe("ConversationQueue", () => {
	it("runs jobs of one conversation in order even when an earlier one is slower", async () => {
		const queue = new ConversationQueue();
		const order: number[] = [];
		queue.run("c", async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push(1);
		});
		queue.run("c", async () => {
			order.push(2);
		});
		await new Promise((r) => setTimeout(r, 60));
		expect(order).toEqual([1, 2]);
	});
});

describe("deliverToConversationReaders", () => {
	function fakeSocket(userId: string) {
		const sent: unknown[] = [];
		let disconnected = false;
		return {
			sent,
			get disconnected() {
				return disconnected;
			},
			socket: {
				data: viewer(userId),
				emit: (_name: string, ev: unknown) => sent.push(ev),
				disconnect: () => {
					disconnected = true;
				},
				// biome-ignore lint/suspicious/noExplicitAny: minimal RemoteSocket stand-in
			} as any,
		};
	}

	it("delivers only to accounts that may read the conversation", async () => {
		const allowed = fakeSocket("allowed");
		const denied = fakeSocket("denied");
		const access = new ConversationAccess(
			"http://api",
			60_000,
			async (_u, token) => token === "tok-allowed",
		);
		const event = { type: "agent.message", payload: { conversation_id: "c" } };
		await deliverToConversationReaders(
			[allowed.socket, denied.socket],
			access,
			"p",
			"c",
			event,
			() => {},
		);
		expect(allowed.sent).toEqual([event]);
		expect(denied.sent).toEqual([]);
	});

	it("fails closed on API errors and disconnects a 401 socket", async () => {
		const flaky = fakeSocket("flaky");
		const expired = fakeSocket("expired");
		const access = new ConversationAccess(
			"http://api",
			60_000,
			async (_u, token) => {
				throw new ApiRequestError("x", token === "tok-expired" ? 401 : 500);
			},
		);
		const errors: string[] = [];
		await deliverToConversationReaders(
			[flaky.socket, expired.socket],
			access,
			"p",
			"c",
			{ type: "agent.message", payload: {} },
			(_e, userId) => errors.push(userId),
		);
		expect(flaky.sent).toEqual([]);
		expect(expired.sent).toEqual([]);
		expect(flaky.disconnected).toBe(false);
		expect(expired.disconnected).toBe(true);
		expect(errors.sort()).toEqual(["expired", "flaky"]);
	});
});

describe("agent event namespaces", () => {
	it("routes conversation content to conversations and bridge status to tasks", () => {
		expect(eventNamespace("agent.message")).toBe("conversations");
		expect(eventNamespace("agent.session.started")).toBe("conversations");
		expect(eventNamespace("agent.acp_bridge.status")).toBe("tasks");
	});
});
