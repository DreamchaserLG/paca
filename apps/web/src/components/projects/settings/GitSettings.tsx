import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Link2, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitWorkflowPanel } from "@/components/projects/settings/GitWorkflowPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
	beginGitAccess,
	followGitStep,
	type GitProvider,
	type GitRepository,
	getApiErrorCodeSafe,
	gitErrorKey,
	gitProjectProvidersQueryOptions,
	gitRepositoriesKey,
	gitRepositoriesQueryOptions,
	linkGitRepository,
	rememberGitFlow,
	repoOwnerOf,
	unlinkGitRepository,
} from "@/lib/git-api";

interface GitSettingsProps {
	projectId: string;
	/** git:write: may link and unlink repositories. */
	canWrite: boolean;
}

const pendingKey = (projectId: string) => `paca.git.pendingLink.${projectId}`;

function readPending(
	projectId: string,
): { input: string; providerId: string } | null {
	try {
		const raw = window.sessionStorage.getItem(pendingKey(projectId));
		if (!raw) return null;
		window.sessionStorage.removeItem(pendingKey(projectId));
		const v = JSON.parse(raw) as { input?: unknown; providerId?: unknown };
		return typeof v.input === "string" && typeof v.providerId === "string"
			? { input: v.input, providerId: v.providerId }
			: null;
	} catch {
		return null;
	}
}

function writePending(projectId: string, input: string, providerId: string) {
	try {
		window.sessionStorage.setItem(
			pendingKey(projectId),
			JSON.stringify({ input, providerId }),
		);
	} catch {
		// Without storage the user just types the repository again.
	}
}

/**
 * The repositories a project works on. Linking goes through the workspace's
 * shared Git identity. When the identity cannot see a repository because it
 * has not been installed on the owner's account (GitHub), the panel offers to
 * install it there — per repository owner, so each project can use a
 * different user or organization — and picks up where the user left off when
 * they come back.
 */
export function GitSettings({ projectId, canWrite }: GitSettingsProps) {
	const { t } = useTranslation("projects");
	const queryClient = useQueryClient();
	const providers = useQuery(gitProjectProvidersQueryOptions(projectId));
	const repos = useQuery(gitRepositoriesQueryOptions(projectId));

	const [input, setInput] = useState("");
	const [providerId, setProviderId] = useState("");
	const [errorKey, setErrorKey] = useState<string | null>(null);
	const [needsAccess, setNeedsAccess] = useState(false);
	const [resumed, setResumed] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);

	const list = providers.data ?? [];
	const provider: GitProvider | undefined =
		list.find((p) => p.id === providerId) ?? list[0];

	// Back from the platform: restore what the user was linking.
	useEffect(() => {
		const pending = readPending(projectId);
		if (pending) {
			setInput(pending.input);
			setProviderId(pending.providerId);
			setResumed(pending.input);
		}
	}, [projectId]);

	const link = useMutation({
		mutationFn: () =>
			linkGitRepository(projectId, {
				provider_id: provider?.id ?? "",
				path_or_url: input.trim(),
			}),
		onSuccess: () => {
			setInput("");
			setErrorKey(null);
			setNeedsAccess(false);
			setResumed(null);
			void queryClient.invalidateQueries({
				queryKey: gitRepositoriesKey(projectId),
			});
		},
		onError: (err: unknown) => {
			setResumed(null);
			if (getApiErrorCodeSafe(err) === "GIT_ACCESS_NOT_GRANTED") {
				setNeedsAccess(true);
				setErrorKey(null);
				return;
			}
			setNeedsAccess(false);
			setErrorKey(gitErrorKey(err));
		},
	});

	const grant = useMutation({
		mutationFn: () =>
			beginGitAccess(projectId, {
				provider_id: provider?.id ?? "",
				owner: repoOwnerOf(input),
				return_url: `${window.location.origin}/projects/${projectId}/settings#git`,
			}),
		onSuccess: (step) => {
			writePending(projectId, input, provider?.id ?? "");
			rememberGitFlow(step.state, { kind: "access", projectId });
			// Leaves the page; the platform returns to /git/setup/callback.
			if (!followGitStep(step)) setErrorKey("generic");
		},
		onError: (err: unknown) => setErrorKey(gitErrorKey(err)),
	});

	const unlink = useMutation({
		mutationFn: (id: string) => unlinkGitRepository(projectId, id),
		onSuccess: () => {
			setConfirming(null);
			void queryClient.invalidateQueries({
				queryKey: gitRepositoriesKey(projectId),
			});
		},
		onError: (err: unknown) => {
			setConfirming(null);
			setErrorKey(gitErrorKey(err));
		},
	});

	if (providers.isLoading || repos.isLoading) {
		return <Skeleton className="h-40 w-full" />;
	}
	const linked: GitRepository[] = repos.data ?? [];
	const owner = repoOwnerOf(input);
	const terms = provider?.terms;

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h2 className="flex items-center gap-2 text-lg font-semibold">
					<GitBranch className="size-4 text-primary" />
					{t("project.git.title")}
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					{t("project.git.description")}
				</p>
			</div>

			{linked.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					{t("project.git.empty")}
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
					{linked.map((r) => (
						<li
							key={r.id}
							className="flex items-center justify-between gap-3 px-4 py-3"
						>
							<div className="min-w-0">
								<p className="truncate text-sm font-medium">{r.full_path}</p>
								<p className="flex items-center gap-2 text-xs text-muted-foreground">
									<span>{r.host}</span>
									{r.default_branch ? (
										<Badge variant="secondary">{r.default_branch}</Badge>
									) : null}
								</p>
							</div>
							{canWrite ? (
								confirming === r.id ? (
									<div className="flex gap-2">
										<Button
											type="button"
											size="sm"
											variant="destructive"
											disabled={unlink.isPending}
											onClick={() => unlink.mutate(r.id)}
										>
											{t("project.git.unlink.confirm")}
										</Button>
										<Button
											type="button"
											size="sm"
											variant="outline"
											onClick={() => setConfirming(null)}
										>
											{t("project.git.unlink.cancel")}
										</Button>
									</div>
								) : (
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => setConfirming(r.id)}
									>
										<Trash2 className="size-4" />
										{t("project.git.unlink.button")}
									</Button>
								)
							) : null}
						</li>
					))}
				</ul>
			)}

			{canWrite ? (
				list.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t("project.git.noProviders")}
					</p>
				) : (
					<form
						className="flex flex-col gap-3 rounded-lg border border-border/60 p-4"
						onSubmit={(e) => {
							e.preventDefault();
							setErrorKey(null);
							setNeedsAccess(false);
							link.mutate();
						}}
					>
						<h3 className="text-sm font-semibold">
							{t("project.git.link.title")}
						</h3>
						{list.length > 1 ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="git-link-provider">
									{t("project.git.link.platform")}
								</Label>
								<select
									id="git-link-provider"
									className="h-9 rounded-md border border-input bg-background px-3 text-sm"
									value={provider?.id ?? ""}
									onChange={(e) => setProviderId(e.target.value)}
								>
									{list.map((p) => (
										<option key={p.id} value={p.id}>
											{p.display_name}
										</option>
									))}
								</select>
							</div>
						) : null}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="git-link-input">
								{terms?.repository ?? t("project.git.link.repository")}
							</Label>
							<Input
								id="git-link-input"
								value={input}
								placeholder={t("project.git.link.placeholder")}
								autoComplete="off"
								onChange={(e) => setInput(e.target.value)}
							/>
						</div>

						{resumed ? (
							<p role="status" className="text-sm text-muted-foreground">
								{t("project.git.resumed", { repository: resumed })}
							</p>
						) : null}

						{needsAccess ? (
							<div
								role="alert"
								className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-3 text-sm"
							>
								<p className="font-medium">{t("project.git.access.title")}</p>
								<p className="text-muted-foreground">
									{owner
										? t("project.git.access.description", {
												provider: provider?.display_name ?? "",
												owner,
											})
										: t("project.git.access.descriptionNoOwner", {
												provider: provider?.display_name ?? "",
											})}
								</p>
								<div>
									<Button
										type="button"
										size="sm"
										disabled={grant.isPending}
										onClick={() => grant.mutate()}
									>
										{grant.isPending ? (
											<Loader2 className="size-4 animate-spin" />
										) : null}
										{owner
											? t("project.git.access.button", { owner })
											: t("project.git.access.buttonNoOwner")}
									</Button>
								</div>
							</div>
						) : null}

						{errorKey ? (
							<p role="alert" className="text-sm text-destructive">
								{t(`project.git.errors.${errorKey}` as never)}
							</p>
						) : null}

						<div>
							<Button
								type="submit"
								disabled={link.isPending || !input.trim() || !provider}
							>
								{link.isPending ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Link2 className="size-4" />
								)}
								{t("project.git.link.button")}
							</Button>
						</div>
					</form>
				)
			) : null}

			{linked.length > 0 ? (
				<GitWorkflowPanel projectId={projectId} canWrite={canWrite} />
			) : null}
		</div>
	);
}
