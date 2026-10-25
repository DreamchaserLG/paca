import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: h.get, put: h.put } },
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		params,
	}: {
		children: React.ReactNode;
		params: { conversationId: string };
	}) => <a href={`/conversations/${params.conversationId}`}>{children}</a>,
}));

import { GitWorkflowPanel } from "./GitWorkflowPanel";

const settings = {
	default_responder_agent_id: null as string | null,
	paused: false,
	min_actor_permission: "write",
};
const agents = [
	{ id: "a1", name: "Dev", handle: "dev" },
	{ id: "a2", name: "Reviewer", handle: "reviewer" },
];
let runs: unknown[] = [];

function renderPanel(canWrite = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<GitWorkflowPanel projectId="p1" canWrite={canWrite} />
		</QueryClientProvider>,
	);
}

describe("GitWorkflowPanel", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		runs = [];
		h.get.mockImplementation(async (url: string) => {
			if (url.endsWith("/git/settings")) return { data: { data: settings } };
			if (url.endsWith("/git/runs")) return { data: { data: runs } };
			if (url.endsWith("/agents"))
				return {
					data: { data: { items: agents, page_size: 50, next_cursor: null } },
				};
			throw new Error(`unexpected GET ${url}`);
		});
		h.put.mockImplementation(async (_url: string, body: unknown) => ({
			data: { data: body },
		}));
	});

	it("saves a changed responder, access bar and pause switch", async () => {
		const user = userEvent.setup();
		renderPanel();
		const responder = await screen.findByLabelText(/default responder/i);
		await screen.findByRole("option", { name: "Reviewer" });
		const save = screen.getByRole("button", { name: /^save$/i });
		expect(save).toBeDisabled();

		await user.selectOptions(responder, "a2");
		await user.selectOptions(
			screen.getByLabelText(/minimum access/i),
			"triage",
		);
		await user.click(screen.getByRole("switch", { name: /pause automation/i }));
		expect(save).toBeEnabled();
		await user.click(save);

		await waitFor(() =>
			expect(h.put).toHaveBeenCalledWith("/projects/p1/git/settings", {
				default_responder_agent_id: "a2",
				paused: true,
				min_actor_permission: "triage",
			}),
		);
		expect(await screen.findByText("Saved.")).toBeInTheDocument();
	});

	it("explains a refusal from the API", async () => {
		h.put.mockRejectedValue({
			response: { status: 404, data: { error_code: "GIT_NOT_FOUND" } },
		});
		const user = userEvent.setup();
		renderPanel();
		await screen.findByRole("option", { name: "Dev" });
		await user.selectOptions(screen.getByLabelText(/default responder/i), "a1");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		expect(await screen.findByRole("alert")).toBeInTheDocument();
	});

	it("is read-only without git:write", async () => {
		renderPanel(false);
		expect(await screen.findByLabelText(/default responder/i)).toBeDisabled();
		expect(screen.getByLabelText(/minimum access/i)).toBeDisabled();
		expect(
			screen.getByRole("switch", { name: /pause automation/i }),
		).toHaveAttribute("aria-disabled", "true");
		expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
	});

	it("lists recent runs with agent, trigger, status and a link to the conversation", async () => {
		runs = [
			{
				id: "r1",
				repository_id: "repo1",
				repository: "acme/web",
				agent_id: "a2",
				trigger: "own_cr_feedback",
				subject_kind: "change_request",
				subject_number: "42",
				conversation_id: "c9",
				status: "succeeded",
				created_at: "2026-01-02T03:04:05Z",
				finished_at: "2026-01-02T03:10:00Z",
			},
		];
		renderPanel();
		expect(await screen.findByText("acme/web #42")).toBeInTheDocument();
		expect(
			screen.getByText(/Reviewer · Feedback on its pull request/),
		).toBeInTheDocument();
		expect(screen.getByText("Succeeded")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /open conversation/i }),
		).toHaveAttribute("href", "/conversations/c9");
	});

	it("says so when nothing has run yet", async () => {
		renderPanel();
		expect(
			await screen.findByText(/no agent run has been started/i),
		).toBeInTheDocument();
	});
});
