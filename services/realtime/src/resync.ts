// Keeping room membership true to IAM while sockets stay connected.
//
// Rooms are joined from the account's effective actions at "join" time, which
// goes stale: a role edit, a detached role or a removed member changes the
// answer. The API announces such changes (iam.changed); on one, the decision
// cache is dropped and every open socket's rooms are re-synced. A periodic
// pass does the same, so a missed Pub/Sub message costs at most one interval.
//
// Work is deduplicated per account + project: one permissions request serves
// all of that account's sockets.

import type { Logger } from "pino";
import type { Server, Socket } from "socket.io";
import type { AccessDecider } from "./access.ts";
import { ApiRequestError, fetchProjectPermissions } from "./api-client.ts";
import type { EventNamespace } from "./permissions.ts";
import { syncProjectRooms } from "./rooms.ts";

const DEFAULT_INTERVAL_MS = 60_000;
const CONCURRENCY = 8;

export interface Resyncer {
	// onIamChanged reacts to the API's iam.changed announcement.
	onIamChanged(): void;
	start(): void;
	stop(): void;
}

export function createResyncer(
	io: Server,
	apiUrl: string,
	decider: AccessDecider,
	logger: Logger,
	intervalMs = DEFAULT_INTERVAL_MS,
): Resyncer {
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;
	let again = false;

	// resyncAll re-syncs every project of every open socket. `announce` also
	// tells the socket its permissions changed so the client refetches its
	// own permission queries; the periodic pass only does so when the rooms
	// actually changed.
	async function resyncAll(announce: boolean): Promise<void> {
		if (running) {
			// An announcement during a pass must not be lost: run once more.
			again = again || announce;
			return;
		}
		running = true;
		try {
			const groups = new Map<string, Socket[]>();
			for (const socket of io.sockets.sockets.values()) {
				for (const projectId of socket.data.projects ?? []) {
					const key = `${socket.data.userId}\u0000${projectId}`;
					const list = groups.get(key);
					if (list) list.push(socket);
					else groups.set(key, [socket]);
				}
			}
			const jobs = [...groups.entries()].map(
				([key, sockets]) =>
					() =>
						resyncGroup(key.split("\u0000")[1] as string, sockets, announce),
			);
			const workers = Array.from({ length: CONCURRENCY }, async () => {
				for (let job = jobs.shift(); job; job = jobs.shift()) await job();
			});
			await Promise.all(workers);
		} finally {
			running = false;
			if (again) {
				again = false;
				void resyncAll(true);
			}
		}
	}

	async function resyncGroup(
		projectId: string,
		sockets: Socket[],
		announce: boolean,
	): Promise<void> {
		const first = sockets[0];
		if (!first) return;
		let perms: Record<string, boolean> | null;
		try {
			perms = await fetchProjectPermissions(
				apiUrl,
				first.data.rawToken,
				projectId,
			);
		} catch (err) {
			logger.warn(
				{ userId: first.data.userId, projectId, err },
				"room resync failed",
			);
			// A dead token cannot be resynced: end the socket so it reconnects
			// with a fresh one. Any other failure keeps the rooms as they are
			// until the next pass; per-event checks still protect delivery.
			if (err instanceof ApiRequestError && err.status === 401) {
				for (const s of sockets) s.disconnect(true);
			}
			return;
		}
		for (const socket of sockets) {
			const before = roomsOf(socket, projectId);
			const after = syncProjectRooms(socket, projectId, perms);
			if (perms === null) socket.data.projects.delete(projectId);
			if (announce || before !== [...after].sort().join(",")) {
				socket.emit("permissions:changed", { projectId, namespaces: after });
			}
		}
	}

	function roomsOf(socket: Socket, projectId: string): string {
		const prefix = `project:${projectId}:`;
		return [...socket.rooms]
			.filter((r) => r.startsWith(prefix))
			.map((r) => r.slice(prefix.length) as EventNamespace)
			.sort()
			.join(",");
	}

	return {
		onIamChanged() {
			// The announcement names roles, not accounts: nothing cached about
			// anyone can be trusted.
			decider.flush();
			void resyncAll(true);
		},
		start() {
			timer = setInterval(() => void resyncAll(false), intervalMs);
			timer.unref();
		},
		stop() {
			if (timer) clearInterval(timer);
		},
	};
}
