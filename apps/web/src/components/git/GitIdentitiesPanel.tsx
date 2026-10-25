import { useQuery } from "@tanstack/react-query";
import { GitBranch, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type GitIdentity,
	type GitProvider,
	gitIdentitiesQueryOptions,
	gitProvidersQueryOptions,
} from "@/lib/git-api";
import { DeleteGitIdentityDialog } from "./DeleteGitIdentityDialog";
import { GitSetupDialog } from "./GitSetupDialog";

/** Providers and the shared bot identity of each of their hosts. */
export function GitIdentitiesPanel() {
	const { t } = useTranslation("admin");
	const providers = useQuery(gitProvidersQueryOptions);
	const identities = useQuery(gitIdentitiesQueryOptions);
	const [setup, setSetup] = useState<{
		provider: GitProvider;
		host: string;
	} | null>(null);
	const [removing, setRemoving] = useState<GitIdentity | null>(null);

	if (providers.isLoading || identities.isLoading) {
		return <Skeleton className="h-40 w-full" />;
	}
	if (providers.isError || identities.isError) {
		return (
			<p role="alert" className="text-sm text-destructive">
				{t("git.errors.generic")}
			</p>
		);
	}
	const list = providers.data ?? [];
	if (list.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>{t("git.noProviders.title")}</CardTitle>
					<CardDescription>{t("git.noProviders.description")}</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	const sharedFor = (providerId: string, host: string) =>
		(identities.data ?? []).find(
			(i) =>
				i.provider_id === providerId &&
				i.scope === "shared" &&
				i.host.toLowerCase() === host.toLowerCase(),
		);

	return (
		<div className="flex flex-col gap-4">
			{list.map((provider) => (
				<Card key={provider.id}>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<GitBranch className="size-4 text-primary" />
							{provider.display_name}
						</CardTitle>
						<CardDescription>{provider.id}</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col divide-y divide-border/60">
						{provider.hosts.map((host) => {
							const identity = sharedFor(provider.id, host);
							return (
								<div
									key={host}
									className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
								>
									<div className="min-w-0">
										<p className="truncate text-sm font-medium">{host}</p>
										{identity ? (
											<p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
												<span className="truncate">
													{identity.display_name || identity.handle}
												</span>
												<Badge variant="secondary">
													{t("git.identity.shared")}
												</Badge>
												{identity.handle ? (
													<span className="font-mono text-xs">
														@{identity.handle}
													</span>
												) : null}
											</p>
										) : (
											<p className="text-sm text-muted-foreground">
												{t("git.identity.none")}
											</p>
										)}
									</div>
									{identity ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => setRemoving(identity)}
										>
											<Trash2 className="size-4" />
											{t("git.delete.button")}
										</Button>
									) : (
										<Button
											type="button"
											size="sm"
											onClick={() => setSetup({ provider, host })}
										>
											{t("git.setup.button")}
										</Button>
									)}
								</div>
							);
						})}
					</CardContent>
				</Card>
			))}

			{setup ? (
				<GitSetupDialog
					provider={setup.provider}
					host={setup.host}
					open
					onOpenChange={(open) => {
						if (!open) setSetup(null);
					}}
				/>
			) : null}
			{removing ? (
				<DeleteGitIdentityDialog
					identity={removing}
					open
					onOpenChange={(open) => {
						if (!open) setRemoving(null);
					}}
				/>
			) : null}
		</div>
	);
}
