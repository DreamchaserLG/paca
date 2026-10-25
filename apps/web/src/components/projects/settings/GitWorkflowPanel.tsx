import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { listAgents } from "@/lib/agent-api";
import {
	GIT_PERMISSIONS,
	type GitPermission,
	type GitProjectSettings,
	type GitRun,
	gitErrorKey,
	gitRunsQueryOptions,
	gitSettingsKey,
	gitSettingsQueryOptions,
	updateGitSettings,
} from "@/lib/git-api";

interface GitWorkflowPanelProps {
	projectId: string;
	/** git:write: may change who starts agents and pause them. */
	canWrite: boolean;
}

const STATUS_VARIANT: Record<
	GitRun["status"],
	"default" | "secondary" | "destructive" | "outline"
> = {
	queued: "outline",
	running: "default",
	succeeded: "secondary",
	failed: "destructive",
	cancelled: "outline",
};

/**
 * How Git events reach this project's agents: who answers a mention that names
 * no agent, how much access an actor needs to start a run, a pause switch, and
 * the runs the events started. Which events start which agent is set per agent
 * (the agent's Git tab).
 */
export function GitWorkflowPanel({
	projectId,
	canWrite,
}: GitWorkflowPanelProps) {
	const { t } = useTranslation("projects");
	const queryClient = useQueryClient();
	const settings = useQuery(gitSettingsQueryOptions(projectId));
	const runs = useQuery(gitRunsQueryOptions(projectId));
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
	const nameOf = (id: string) =>
		agentList.find((a) => a.id === id)?.name ?? "—";
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

			<div className="flex flex-col gap-2">
				<h3 className="text-sm font-semibold">
					{t("project.git.workflow.runs.title")}
				</h3>
				{runs.isLoading ? (
					<Skeleton className="h-16 w-full" />
				) : (runs.data ?? []).length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t("project.git.workflow.runs.empty")}
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
						{(runs.data ?? []).map((r) => (
							<li
								key={r.id}
								className="flex items-center justify-between gap-3 px-4 py-2.5"
							>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium">
										{r.repository}
										{r.subject_number ? ` #${r.subject_number}` : ""}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										{nameOf(r.agent_id)} ·{" "}
										{t(`project.git.triggerKinds.${r.trigger}.label` as never)}{" "}
										· {new Date(r.created_at).toLocaleString()}
									</p>
								</div>
								<div className="flex items-center gap-3">
									<Badge variant={STATUS_VARIANT[r.status]}>
										{t(`project.git.workflow.runs.status.${r.status}` as never)}
									</Badge>
									{r.conversation_id ? (
										<Link
											to="/projects/$projectId/conversations/$conversationId"
											params={{ projectId, conversationId: r.conversation_id }}
											className="text-xs text-primary hover:underline"
										>
											{t("project.git.workflow.runs.open")}
										</Link>
									) : null}
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
