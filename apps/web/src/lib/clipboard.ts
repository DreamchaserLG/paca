// navigator.clipboard is only defined in a secure context (https or
// localhost). Paca is commonly served over plain http (LAN IP, internal
// hostname), where navigator.clipboard is undefined and writeText can't be
// used. document.execCommand("copy") has no such restriction, so it's the
// fallback whenever the modern API is unavailable or rejects.
export async function copyToClipboard(text: string): Promise<boolean> {
	if (
		typeof window !== "undefined" &&
		window.isSecureContext &&
		navigator.clipboard?.writeText
	) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to the execCommand fallback below.
		}
	}

	if (typeof document === "undefined") return false;

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	// Off-screen but still selectable -- execCommand("copy") acts on the
	// current selection, so the element must really be selected.
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.left = "0";
	textarea.style.opacity = "0";
	// Keep focus/selection inside the active element (e.g. a modal's focus
	// trap) from being lost permanently.
	const previouslyFocused = document.activeElement as HTMLElement | null;
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	let ok: boolean;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	textarea.remove();
	previouslyFocused?.focus?.();
	return ok;
}
