import { useMutation, useQuery } from "@tanstack/react-query";
import { GitBranch, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DeleteGitIdentityDialog } from "@/components/git/DeleteGitIdentityDialog";
import { GitSetupDialog } from "@/components/git/GitSetupDialog";
import { AgentGitTriggers } from "@/components/projects/agents/AgentGitTriggers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/use-permissions";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import {
	agentGitIdentitiesKey,
	agentGitIdentitiesQueryOptions,
	beginAgentGitAccess,
	beginAgentGitSetup,
	deleteAgentGitIdentity,
	followGitStep,
	forgetAgentInstall,
	type GitIdentity,
	type GitProvider,
	gitErrorKey,
	gitProjectProvidersQueryOptions,
	rememberAgentInstall,
	rememberGitFlow,
} from "@/lib/git-api";

interface AgentGitTabProps {
	projectId: string;
	agentId: string;
	/** agents:write on this agent. */
	canWrite: boolean;
}

/**
 * An agent's Git identity. By default an agent acts through the workspace's
 * shared identity; here it can get its own (so its commits, pull requests and
 * comments appear under a separate bot) and install that identity on the
 * accounts and organizations whose repositories it works on.
 *
 * Creating or removing an identity creates or removes an app on the Git
 * platform, which needs the workspace-level git.identities:manage. Installing
 * an existing one on another account needs the agent's agents:write and the
 * project's git:write. What the platform lets a user install is the platform's
 * own check.
 */
export function AgentGitTab({
	projectId,
	agentId,
	canWrite,
}: AgentGitTabProps) {
	const { t } = useTranslation("projects");
	const { hasPermission } = usePermissions();
	const { hasProjectPermission } = useProjectPermissions(projectId);
	const canManage = hasPermission("git.identities:manage");
	const canInstall =
		canWrite &&
		(hasPermission("git:write") || hasProjectPermission("git:write"));

	const providers = useQuery(gitProjectProvidersQueryOptions(projectId));
	const identities = useQuery(
		agentGitIdentitiesQueryOptions(projectId, agentId),
	);

	const [creating, setCreating] = useState<GitProvider | null>(null);
	const [removing, setRemoving] = useState<GitIdentity | null>(null);

	if (providers.isLoading || identities.isLoading) {
		return <Skeleton className="h-40 w-full" />;
	}
	const list = providers.data ?? [];
	const own = (providerId: string) =>
		(identities.data ?? []).find((i) => i.provider_id === providerId);

	return (
		<div className="flex max-w-3xl flex-col gap-6">
			<div>
				<h2 className="flex items-center gap-2 text-lg font-semibold">
					<GitBranch className="size-4 text-primary" />
					{t("agents.detail.git.title")}
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					{t("agents.detail.git.description")}
				</p>
			</div>

			{providers.isError ? (
				<p role="alert" className="text-sm text-muted-foreground">
					{t("agents.detail.git.providersUnavailable")}
				</p>
			) : list.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					{t("agents.detail.git.noProviders")}
				</p>
			) : (
				list.map((provider) => {
					const identity = own(provider.id);
					return (
						<section
							key={provider.id}
							className="flex flex-col gap-4 rounded-lg border border-border/60 p-4"
						>
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<h3 className="truncate text-sm font-semibold">
										{provider.display_name}
									</h3>
									{identity ? (
										<p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
											<span className="truncate">
												{identity.display_name || identity.handle}
											</span>
											{identity.handle ? (
												<span className="font-mono text-xs">
													@{identity.handle}
												</span>
											) : null}
											<Badge variant="secondary">
												{t("agents.detail.git.ownIdentity")}
											</Badge>
										</p>
									) : (
										<p className="text-sm text-muted-foreground">
											{t("agents.detail.git.usesShared")}
										</p>
									)}
								</div>
								{identity ? (
									canManage ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => setRemoving(identity)}
										>
											<Trash2 className="size-4" />
											{t("agents.detail.git.remove")}
										</Button>
									) : null
								) : !provider.capabilities.multiple_identities ? (
									<span className="text-xs text-muted-foreground">
										{t("agents.detail.git.singleIdentity")}
									</span>
								) : canManage ? (
									<Button
										type="button"
										size="sm"
										disabled={!canWrite}
										onClick={() => setCreating(provider)}
									>
										{t("agents.detail.git.create")}
									</Button>
								) : (
									<span className="text-xs text-muted-foreground">
										{t("agents.detail.git.askAdmin")}
									</span>
								)}
							</div>

							{identity && provider.capabilities.access_grants ? (
								canInstall ? (
									<InstallOnAccount
										projectId={projectId}
										agentId={agentId}
										provider={provider}
									/>
								) : null
							) : null}
						</section>
					);
				})
			)}

			{list.length > 0 ? (
				<AgentGitTriggers
					projectId={projectId}
					agentId={agentId}
					canWrite={canWrite}
				/>
			) : null}

			{creating ? (
				<GitSetupDialog
					provider={creating}
					host={creating.hosts[0] ?? ""}
					open
					onOpenChange={(open) => {
						if (!open) setCreating(null);
					}}
					begin={async (payload) => {
						// The App is installed right after it is created.
						rememberAgentInstall({ projectId, agentId });
						try {
							return await beginAgentGitSetup(projectId, agentId, payload);
						} catch (err) {
							forgetAgentInstall();
							throw err;
						}
					}}
					returnPath={`/projects/${projectId}/agents/${agentId}#git`}
					invalidateKey={agentGitIdentitiesKey(projectId, agentId)}
				/>
			) : null}
			{removing ? (
				<DeleteGitIdentityDialog
					identity={removing}
					open
					onOpenChange={(open) => {
						if (!open) setRemoving(null);
					}}
					remove={() =>
						deleteAgentGitIdentity(projectId, agentId, removing.provider_id)
					}
					invalidateKey={agentGitIdentitiesKey(projectId, agentId)}
				/>
			) : null}
		</div>
	);
}

/**
 * Installs the agent's identity on an account or organization, so it can reach
 * that owner's repositories. The platform's install page opens (pre-selecting
 * the owner when one is typed) and returns to the Paca callback, which brings
 * the user back to this tab.
 */
function InstallOnAccount({
	projectId,
	agentId,
	provider,
}: {
	projectId: string;
	agentId: string;
	provider: GitProvider;
}) {
	const { t } = useTranslation("projects");
	const [owner, setOwner] = useState("");
	const [errorKey, setErrorKey] = useState<string | null>(null);

	const install = useMutation({
		mutationFn: () =>
			beginAgentGitAccess(projectId, agentId, {
				provider_id: provider.id,
				owner: owner.trim(),
				return_url: `${window.location.origin}/projects/${projectId}/agents/${agentId}#git`,
			}),
		onSuccess: (step) => {
			rememberGitFlow(step.state, { kind: "access", projectId });
			// Leaves the page; the platform returns to /git/setup/callback.
			if (!followGitStep(step)) setErrorKey("generic");
		},
		onError: (err: unknown) => setErrorKey(gitErrorKey(err)),
	});

	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				setErrorKey(null);
				install.mutate();
			}}
		>
			<Label htmlFor={`git-agent-owner-${provider.id}`}>
				{t("agents.detail.git.install.label")}
			</Label>
			<div className="flex gap-2">
				<Input
					id={`git-agent-owner-${provider.id}`}
					value={owner}
					autoComplete="off"
					placeholder={t("agents.detail.git.install.placeholder")}
					onChange={(e) => setOwner(e.target.value)}
				/>
				<Button type="submit" variant="outline" disabled={install.isPending}>
					{install.isPending ? (
						<Loader2 className="size-4 animate-spin" />
					) : null}
					{t("agents.detail.git.install.button")}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				{t("agents.detail.git.install.help")}
			</p>
			{errorKey ? (
				<p role="alert" className="text-sm text-destructive">
					{t(`project.git.errors.${errorKey}` as never)}
				</p>
			) : null}
		</form>
	);
}
