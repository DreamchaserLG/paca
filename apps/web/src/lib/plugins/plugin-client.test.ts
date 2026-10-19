import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginApiClient } from "./plugin-client";

function stubFetch(data: unknown) {
	const fetchMock = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ success: true, data }),
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("plugin api client tasks", () => {
	const page = {
		items: [{ id: "t1" }, { id: "t2" }],
		page_size: 200,
		next_cursor: "c2",
		total_count: 450,
	};

	it("listTasksPage keeps the cursor and total so a plugin can read on", async () => {
		const fetchMock = stubFetch(page);
		const api = createPluginApiClient("p1");

		await expect(
			api.listTasksPage({ cursor: "c1", sprint_id: "s1" }),
		).resolves.toEqual(page);

		const url = new URL(fetchMock.mock.calls[0][0] as string);
		expect(url.pathname).toBe("/api/v1/projects/p1/tasks");
		expect(url.searchParams.get("cursor")).toBe("c1");
		expect(url.searchParams.get("sprint_id")).toBe("s1");
		expect(url.searchParams.get("page_size")).toBe("200");
	});

	it("listTasks still returns the plain first-page array", async () => {
		stubFetch(page);
		const api = createPluginApiClient("p1");
		await expect(api.listTasks()).resolves.toEqual(page.items);
	});

	it("ignores the old numbered `page` filter, which the task list does not take", async () => {
		const fetchMock = stubFetch(page);
		await createPluginApiClient("p1").listTasksPage({ page: 3 });
		const url = new URL(fetchMock.mock.calls[0][0] as string);
		expect(url.searchParams.has("page")).toBe(false);
	});
});
