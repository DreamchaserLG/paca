import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	agentGitTriggersKey,
	agentGitTriggersQueryOptions,
	type GitAutoReviewConfig,
	type GitTrigger,
	gitErrorKey,
	setAgentGitTrigger,
} from "@/lib/git-api";

interface AgentGitTriggersProps {
	projectId: string;
	agentId: string;
	/** agents:write on this agent. */
	canWrite: boolean;
}

const list = (s: string): string[] =>
	s
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);

/**
 * Which Git events start this agent: a mention, feedback on a pull request it
 * opened, a CI failure on one, a review request, a label, or every new pull
 * request (auto review, off until switched on). Only triggers some installed
 * provider can deliver are offered.
 */
export function AgentGitTriggers({
	projectId,
	agentId,
	canWrite,
}: AgentGitTriggersProps) {
	const { t } = useTranslation("projects");
	const queryClient = useQueryClient();
	const triggers = useQuery(agentGitTriggersQueryOptions(projectId, agentId));
	const [errorKey, setErrorKey] = useState<string | null>(null);

	const set = useMutation({
		mutationFn: (v: {
			kind: GitTrigger["kind"];
			enabled: boolean;
			config?: GitAutoReviewConfig;
		}) =>
			setAgentGitTrigger(projectId, agentId, v.kind, {
				enabled: v.enabled,
				config: v.config,
			}),
		onSuccess: (next) => {
			setErrorKey(null);
			queryClient.setQueryData(agentGitTriggersKey(projectId, agentId), next);
		},
		onError: (err: unknown) => setErrorKey(gitErrorKey(err)),
	});

	if (triggers.isLoading) return <Skeleton className="h-32 w-full" />;
	const offered = (triggers.data ?? []).filter((x) => x.supported);
	if (triggers.isError || offered.length === 0) return null;

	return (
		<section className="flex flex-col gap-3 rounded-lg border border-border/60 p-4">
			<div>
				<h3 className="text-sm font-semibold">
					{t("agents.detail.git.triggers.title")}
				</h3>
				<p className="text-xs text-muted-foreground">
					{t("agents.detail.git.triggers.description")}
				</p>
			</div>
			<ul className="flex flex-col divide-y divide-border/60">
				{offered.map((trigger) => (
					<li key={trigger.kind} className="flex flex-col gap-2 py-2.5">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<Label htmlFor={`git-trigger-${trigger.kind}`}>
									{t(`project.git.triggerKinds.${trigger.kind}.label` as never)}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t(
										`project.git.triggerKinds.${trigger.kind}.description` as never,
									)}
								</p>
							</div>
							<Switch
								id={`git-trigger-${trigger.kind}`}
								checked={trigger.enabled}
								disabled={!canWrite || set.isPending}
								onCheckedChange={(enabled) =>
									set.mutate({
										kind: trigger.kind,
										enabled,
										config: trigger.explicit ? trigger.config : undefined,
									})
								}
							/>
						</div>
						{trigger.kind === "auto_review" && trigger.enabled ? (
							<AutoReviewFilters
								trigger={trigger}
								canWrite={canWrite}
								pending={set.isPending}
								onSave={(config) =>
									set.mutate({ kind: trigger.kind, enabled: true, config })
								}
							/>
						) : null}
					</li>
				))}
			</ul>
			{errorKey ? (
				<p role="alert" className="text-sm text-destructive">
					{t(`project.git.errors.${errorKey}` as never)}
				</p>
			) : null}
		</section>
	);
}

function AutoReviewFilters({
	trigger,
	canWrite,
	pending,
	onSave,
}: {
	trigger: GitTrigger;
	canWrite: boolean;
	pending: boolean;
	onSave: (config: GitAutoReviewConfig) => void;
}) {
	const { t } = useTranslation("projects");
	const [branches, setBranches] = useState("");
	const [authors, setAuthors] = useState("");

	useEffect(() => {
		setBranches((trigger.config.branches ?? []).join(", "));
		setAuthors((trigger.config.authors ?? []).join(", "));
	}, [trigger.config]);

	return (
		<form
			className="grid gap-2 sm:grid-cols-2"
			onSubmit={(e) => {
				e.preventDefault();
				onSave({ branches: list(branches), authors: list(authors) });
			}}
		>
			<div className="flex flex-col gap-1">
				<Label htmlFor="git-auto-branches">
					{t("agents.detail.git.triggers.filters.branches")}
				</Label>
				<Input
					id="git-auto-branches"
					value={branches}
					disabled={!canWrite}
					placeholder="main, release"
					onChange={(e) => setBranches(e.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor="git-auto-authors">
					{t("agents.detail.git.triggers.filters.authors")}
				</Label>
				<Input
					id="git-auto-authors"
					value={authors}
					disabled={!canWrite}
					placeholder="alice, dependabot[bot]"
					onChange={(e) => setAuthors(e.target.value)}
				/>
			</div>
			<p className="text-xs text-muted-foreground sm:col-span-2">
				{t("agents.detail.git.triggers.filters.help")}
			</p>
			{canWrite ? (
				<div className="sm:col-span-2">
					<Button type="submit" size="sm" variant="outline" disabled={pending}>
						{pending ? <Loader2 className="size-4 animate-spin" /> : null}
						{t("agents.detail.git.triggers.filters.save")}
					</Button>
				</div>
			) : null}
		</form>
	);
}
