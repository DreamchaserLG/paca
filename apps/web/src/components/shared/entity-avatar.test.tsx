import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntityAvatar } from "./entity-avatar";

// base-ui's Avatar only mounts <img> once the image has loaded, so in jsdom
// (which never loads images) we assert on the fallback content instead.
describe("EntityAvatar fallback", () => {
	it("shows initials for a human", () => {
		const { getByText } = render(<EntityAvatar name="Ada Lovelace" />);
		expect(getByText("AL")).toBeInTheDocument();
	});

	it("shows the Paca mark for a service account", () => {
		const { container, queryByText } = render(
			<EntityAvatar name="CI Bot" type="service_account" />,
		);
		expect(queryByText("CB")).not.toBeInTheDocument();
		const srcs = [...container.querySelectorAll("img")].map((i) =>
			i.getAttribute("src"),
		);
		expect(srcs).toContain("/paca-logo.svg");
	});

	it("shows the Paca mark for an agent with an unmapped provider", () => {
		const { container } = render(
			<EntityAvatar
				name="Helper"
				type="agent"
				agent={{ agentType: "llm", llmProvider: "custom" }}
			/>,
		);
		const srcs = [...container.querySelectorAll("img")].map((i) =>
			i.getAttribute("src"),
		);
		expect(srcs).toContain("/paca-logo.svg");
	});

	it("uses the given fallback for a nameless human", () => {
		const { getByText } = render(
			<EntityAvatar name="" fallback={<span>icon</span>} />,
		);
		expect(getByText("icon")).toBeInTheDocument();
	});
});
