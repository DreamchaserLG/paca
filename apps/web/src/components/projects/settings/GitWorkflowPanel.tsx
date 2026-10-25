import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { listAgents } from "@/lib/agent-api";
import {
	GIT_PERMISSIONS,
	type GitPermission,
	type GitProjectSettings,
	gitErrorKey,
	gitSettingsKey,
	gitSettingsQueryOptions,
	updateGitSettings,
} from "@/lib/git-api";

interface GitWorkflowPanelProps {
	projectId: string;
	/** git:write: may change who starts agents and pause them. */
	canWrite: boolean;
}

/**
 * How Git events reach this project's agents: who answers a mention that names
 * no agent, how much access an actor needs to start a run, a pause switch, and
 Which events start which agent is set per agent
 * (the agent's Git tab).
 */
export function GitWorkflowPanel({
	projectId,
	canWrite,
}: GitWorkflowPanelProps) {
	const { t } = useTranslation("projects");
	const queryClient = useQueryClient();
	const settings = useQuery(gitSettingsQueryOptions(projectId));
	const agents = useQuery({
		queryKey: ["git", "projects", projectId, "responder-candidates"] as const,
		queryFn: () => listAgents(projectId),
	});

	const [draft, setDraft] = useState<GitProjectSettings | null>(null);
	const [errorKey, setErrorKey] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		if (settings.data) setDraft(settings.data);
	}, [settings.data]);

	const save = useMutation({
		mutationFn: (next: GitProjectSettings) =>
			updateGitSettings(projectId, next),
		onSuccess: (next) => {
			queryClient.setQueryData(gitSettingsKey(projectId), next);
			setDraft(next);
			setErrorKey(null);
			setSaved(true);
		},
		onError: (err: unknown) => {
			setSaved(false);
			setErrorKey(gitErrorKey(err));
		},
	});

	if (settings.isLoading || !draft) {
		return <Skeleton className="h-32 w-full" />;
	}
	const agentList = agents.data?.items ?? [];
	const dirty =
		JSON.stringify(draft) !== JSON.stringify(settings.data ?? draft);
	const change = (patch: Partial<GitProjectSettings>) => {
		setSaved(false);
		setDraft({ ...draft, ...patch });
	};

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="flex items-center gap-2 text-lg font-semibold">
					<Bot className="size-4 text-primary" />
					{t("project.git.workflow.title")}
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					{t("project.git.workflow.description")}
				</p>
			</div>

			<form
				className="flex flex-col gap-4 rounded-lg border border-border/60 p-4"
				onSubmit={(e) => {
					e.preventDefault();
					save.mutate(draft);
				}}
			>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="git-responder">
						{t("project.git.workflow.responder.label")}
					</Label>
					<select
						id="git-responder"
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						disabled={!canWrite}
						value={draft.default_responder_agent_id ?? ""}
						onChange={(e) =>
							change({ default_responder_agent_id: e.target.value || null })
						}
					>
						<option value="">{t("project.git.workflow.responder.none")}</option>
						{agentList.map((a) => (
							<option key={a.id} value={a.id}>
								{a.name}
							</option>
						))}
					</select>
					<p className="text-xs text-muted-foreground">
						{t("project.git.workflow.responder.help")}
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="git-min-permission">
						{t("project.git.workflow.minPermission.label")}
					</Label>
					<select
						id="git-min-permission"
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						disabled={!canWrite}
						value={draft.min_actor_permission}
						onChange={(e) =>
							change({ min_actor_permission: e.target.value as GitPermission })
						}
					>
						{GIT_PERMISSIONS.map((p) => (
							<option key={p} value={p}>
								{t(`project.git.workflow.permission.${p}` as never)}
							</option>
						))}
					</select>
					<p className="text-xs text-muted-foreground">
						{t("project.git.workflow.minPermission.help")}
					</p>
				</div>

				<div className="flex items-center justify-between gap-3">
					<div>
						<Label htmlFor="git-paused">
							{t("project.git.workflow.paused.label")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("project.git.workflow.paused.help")}
						</p>
					</div>
					<Switch
						id="git-paused"
						checked={draft.paused}
						disabled={!canWrite}
						onCheckedChange={(v) => change({ paused: v })}
					/>
				</div>

				{errorKey ? (
					<p role="alert" className="text-sm text-destructive">
						{t(`project.git.errors.${errorKey}` as never)}
					</p>
				) : null}
				{saved ? (
					<p role="status" className="text-sm text-muted-foreground">
						{t("project.git.workflow.saved")}
					</p>
				) : null}

				{canWrite ? (
					<div>
						<Button type="submit" disabled={!dirty || save.isPending}>
							{save.isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : null}
							{t("project.git.workflow.save")}
						</Button>
					</div>
				) : null}
			</form>
		</div>
	);
}
