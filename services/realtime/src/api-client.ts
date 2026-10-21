// API client used by the realtime service to delegate authentication and
// permission lookups to services/api.
//
// The realtime service never verifies JWTs locally — the API is the single
// source of truth. If the API rejects the token (expired, revoked, malformed)
// the socket connection is refused or the operation is rejected.

export interface AuthResult {
	userId: string;
	username: string;
	role: string;
	globalPermissions: string[];
}

// Thrown by the API calls below so callers can distinguish an expired/invalid
// token (401 — the caller may want to force a reconnect) from any other
// failure (network blip, API 5xx) without parsing the error message.
export class ApiRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ApiRequestError";
	}
}

// All API responses are wrapped in a standard success envelope:
// { success: true, data: <T> }
interface ApiEnvelope<T> {
	success: boolean;
	data: T;
}

interface GlobalPermissionsData {
	permissions: string[];
}

interface ProjectPermissionsData {
	actions: string[];
}

// verifyTokenWithAPI calls GET /api/v1/users/me/global-permissions using the
// supplied access token. A successful 200 response proves the token is valid;
// the response body also provides the caller's global permission list.
// User identity fields (userId, username, role) are extracted from the JWT
// payload without signature verification — they are trusted because the API
// has already verified the signature.
export async function verifyTokenWithAPI(
	apiUrl: string,
	token: string,
): Promise<AuthResult> {
	const res = await fetch(`${apiUrl}/api/v1/users/me/global-permissions`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(8_000),
	});

	if (!res.ok) {
		throw new ApiRequestError(
			`API auth rejected token: HTTP ${res.status}`,
			res.status,
		);
	}

	const envelope = (await res.json()) as ApiEnvelope<GlobalPermissionsData>;

	// Decode identity claims from the JWT payload (no signature check — the
	// API call above is the verification).
	const { sub, username, role } = decodePayload(token);

	return {
		userId: sub,
		username,
		role,
		globalPermissions: Array.isArray(envelope.data?.permissions)
			? envelope.data.permissions
			: [],
	};
}

// fetchProjectPermissions calls GET /api/v1/projects/:projectId/members/me/permissions
// to retrieve the authenticated user's effective IAM actions in a project
// ("tasks:read", ...), returned as a map of action -> true. scope=project
// leaves out actions held only on a single task/doc/etc.: a room delivers
// every event of its namespace, so it needs project-wide access.
// Returns null when the user is not a member of that project (API returns 404).
export async function fetchProjectPermissions(
	apiUrl: string,
	token: string,
	projectId: string,
): Promise<Record<string, boolean> | null> {
	const res = await fetch(
		`${apiUrl}/api/v1/projects/${encodeURIComponent(projectId)}/members/me/permissions?scope=project`,
		{
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(8_000),
		},
	);

	if (res.status === 404) return null; // not a project member
	if (!res.ok) {
		throw new Error(`API project permissions failed: HTTP ${res.status}`);
	}

	const envelope = (await res.json()) as ApiEnvelope<ProjectPermissionsData>;
	return Object.fromEntries(
		(envelope.data?.actions ?? []).map((action) => [action, true]),
	);
}

// canReadConversation asks the API whether the token's account may read one
// conversation, by fetching it through GET /projects/:projectId/conversations/:id
// — the route the REST side gates on conversations:read for that specific
// conversation (so per-conversation / per-environment policies apply). A
// project-wide permission list cannot answer this: it cannot see a policy
// that excludes a single conversation. Returns false for 403/404; throws on
// anything else (a 401 as an ApiRequestError so the caller can force a fresh
// handshake) so callers fail closed instead of caching a guess.
export async function canReadConversation(
	apiUrl: string,
	token: string,
	projectId: string,
	conversationId: string,
): Promise<boolean> {
	const res = await fetch(
		`${apiUrl}/api/v1/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
		{
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(8_000),
		},
	);
	if (res.ok) return true;
	if (res.status === 403 || res.status === 404) return false;
	throw new ApiRequestError(
		`API conversation access check failed: HTTP ${res.status}`,
		res.status,
	);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface JwtPayload {
	sub: string;
	username: string;
	role: string;
}

function decodePayload(token: string): JwtPayload {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("malformed JWT: expected 3 parts");

	// Standard base64url decode; Buffer is available in Bun.
	if (!parts[1]) throw new Error("malformed JWT: empty payload");
	const raw = parts[1];
	const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const json = Buffer.from(padded, "base64").toString("utf8");

	const payload = JSON.parse(json) as Record<string, unknown>;

	const sub = payload.sub;
	const username = payload.username;
	const role = payload.role;

	if (typeof sub !== "string" || !sub)
		throw new Error("JWT payload missing sub");
	if (typeof username !== "string" || !username)
		throw new Error("JWT payload missing username");
	if (typeof role !== "string" || !role)
		throw new Error("JWT payload missing role");

	return { sub, username, role };
}
