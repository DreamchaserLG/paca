import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("uses navigator.clipboard in a secure context", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("isSecureContext", true);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		expect(await copyToClipboard("hi")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("hi");
	});

	it("falls back to execCommand when navigator.clipboard is unavailable", async () => {
		vi.stubGlobal("isSecureContext", false);
		vi.stubGlobal("navigator", {});
		const exec = vi.fn().mockReturnValue(true);
		document.execCommand = exec;
		expect(await copyToClipboard("hi")).toBe(true);
		expect(exec).toHaveBeenCalledWith("copy");
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("falls back when writeText rejects, and reports failure", async () => {
		vi.stubGlobal("isSecureContext", true);
		vi.stubGlobal("navigator", {
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
		});
		document.execCommand = vi.fn().mockReturnValue(false);
		expect(await copyToClipboard("hi")).toBe(false);
	});
});
