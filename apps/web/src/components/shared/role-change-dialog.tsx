import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import {
	type RoleOption,
	RoleSelectPanel,
} from "@/components/admin/global-roles/role-select";
import { InlineNotice } from "@/components/shared/inline-notice";
import { RoleBadge, toRoleBadgeData } from "@/components/shared/role-badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { getInitials } from "@/lib/initials";

interface RoleChangeDialogProps<T extends RoleOption> {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	person: { name: string; handle: string; avatarUrl?: string | null };
	roles: T[];
	/** Shown in place of the list and summary while the roles are not
	 * available (loading, failed, none). */
	status?: ReactNode;
	currentIds: string[];
	/** The fewest roles that must stay picked (1 for a project member). */
	minSelected?: number;
	badgeClass?: (permission: string) => string;
	saveLabel: string;
	savingLabel: string;
	cancelLabel: string;
	isPending: boolean;
	error?: string | null;
	/** Called as soon as the picks change, so the caller can clear its error. */
	onPick?: () => void;
	/** Notices that depend on what is being picked (full access, own account). */
	warnings?: (change: { ids: string[]; roles: T[] }) => ReactNode;
	onSave: (ids: string[]) => void;
}

const sameSet = (a: string[], b: string[]) =>
	a.length === b.length && a.every((x) => b.includes(x));

/**
 * The one place roles are changed, for workspace users and project members:
 * who it is, the roles to pick from (searchable, with each role's
 * description), a summary of exactly what saving adds and removes, and a
 * sticky Save bar. Nothing is written until Save.
 */
export function RoleChangeDialog<T extends RoleOption>({
	open,
	onOpenChange,
	title,
	description,
	person,
	roles,
	status,
	currentIds,
	minSelected = 0,
	badgeClass,
	saveLabel,
	savingLabel,
	cancelLabel,
	isPending,
	error,
	onPick,
	warnings,
	onSave,
}: RoleChangeDialogProps<T>) {
	const { t } = useTranslation("shared");
	// null until the person touches the list: it then shows the roles held.
	const [picked, setPicked] = useState<string[] | null>(null);
	const ids = picked ?? currentIds;
	const change = picked && !sameSet(picked, currentIds) ? picked : null;

	const added = roles.filter(
		(r) => ids.includes(r.id) && !currentIds.includes(r.id),
	);
	const removed = roles.filter(
		(r) => !ids.includes(r.id) && currentIds.includes(r.id),
	);

	const handleOpenChange = (next: boolean) => {
		if (!next) setPicked(null);
		onOpenChange(next);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="gap-0 p-0 sm:max-w-md">
				<DialogHeader className="gap-3 border-b p-5 pr-12">
					<div className="flex items-center gap-3">
						<Avatar className="size-10 shrink-0">
							{person.avatarUrl ? (
								<AvatarImage src={person.avatarUrl} alt="" />
							) : null}
							<AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
								{getInitials(person.name)}
							</AvatarFallback>
						</Avatar>
						<div className="min-w-0">
							<DialogTitle className="truncate text-base">{title}</DialogTitle>
							<p className="truncate text-sm font-medium">{person.name}</p>
							<p className="truncate text-xs text-muted-foreground">
								@{person.handle}
							</p>
						</div>
					</div>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div className="flex max-h-[60vh] min-h-0 flex-col gap-4 overflow-y-auto p-5">
					{status ?? (
						<>
							<RoleSelectPanel
								roles={roles}
								values={ids}
								currentRoleIds={currentIds}
								label={title}
								badgeClass={badgeClass}
								minSelected={minSelected}
								disabled={isPending}
								onChange={(next) => {
									setPicked(next);
									onPick?.();
								}}
							/>

							<div
								className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-xs"
								aria-live="polite"
							>
								{change ? (
									<>
										{added.length > 0 ? (
											<ChangeRow label={t("roleChange.adding")} tone="add">
												{added.map((r) => (
													<RoleBadge
														key={r.id}
														role={toRoleBadgeData(r)}
														interactive={false}
													/>
												))}
											</ChangeRow>
										) : null}
										{removed.length > 0 ? (
											<ChangeRow label={t("roleChange.removing")} tone="remove">
												{removed.map((r) => (
													<RoleBadge
														key={r.id}
														role={toRoleBadgeData(r)}
														interactive={false}
													/>
												))}
											</ChangeRow>
										) : null}
									</>
								) : (
									<p className="text-muted-foreground">
										{t("roleChange.noChanges")}
									</p>
								)}
							</div>
						</>
					)}

					{change && warnings
						? warnings({
								ids: change,
								roles: roles.filter((r) => change.includes(r.id)),
							})
						: null}
					{error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
				</div>

				<DialogFooter className="m-0 rounded-b-xl border-t p-4">
					<DialogClose render={<Button variant="outline" />}>
						{cancelLabel}
					</DialogClose>
					<Button
						onClick={() => change && onSave(change)}
						disabled={!change || isPending}
					>
						{isPending ? savingLabel : saveLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ChangeRow({
	label,
	tone,
	children,
}: {
	label: string;
	tone: "add" | "remove";
	children: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span
				className={
					tone === "add"
						? "min-w-20 shrink-0 font-medium text-emerald-600 dark:text-emerald-400"
						: "min-w-20 shrink-0 font-medium text-destructive"
				}
			>
				{tone === "add" ? "+ " : "− "}
				{label}
			</span>
			{children}
		</div>
	);
}
