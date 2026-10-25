import type { LucideIcon } from "lucide-react";
import { Check, CircleDashed, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** A snippet the user is meant to type or paste somewhere else, with a copy button. */
export function CopyChip({
	value,
	label,
	className,
}: {
	value: string;
	/** What the button copies, for screen readers. */
	label?: string;
	className?: string;
}) {
	const { t } = useTranslation("admin");
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/50 py-0.5 pl-2 pr-0.5 font-mono text-xs",
				className,
			)}
		>
			<span className="truncate">{value}</span>
			<button
				type="button"
				aria-label={`${t("git.copy")}: ${label ?? value}`}
				title={copied ? t("git.copied") : t("git.copy")}
				className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
				onClick={() => {
					void navigator.clipboard?.writeText(value);
					setCopied(true);
					if (timer.current) clearTimeout(timer.current);
					timer.current = setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			</button>
		</span>
	);
}

export type StepStatus = "done" | "current" | "todo";

export interface StepItem {
	id: string;
	title: string;
	description?: ReactNode;
	status: StepStatus;
	/** What to do now; shown under the description. */
	action?: ReactNode;
}

/**
 * A numbered checklist: finished steps are checked, the next one is
 * highlighted with its action, the rest wait. It answers "what do I do next?".
 */
export function StepList({ steps }: { steps: StepItem[] }) {
	const { t } = useTranslation("admin");
	return (
		<ol className="flex flex-col">
			{steps.map((s, i) => (
				<li
					key={s.id}
					data-status={s.status}
					className="relative flex gap-3 pb-4 last:pb-0"
				>
					{i < steps.length - 1 ? (
						<span
							aria-hidden="true"
							className={cn(
								"absolute left-[11px] top-6 bottom-0 w-px",
								s.status === "done" ? "bg-primary/40" : "bg-border",
							)}
						/>
					) : null}
					<span
						className={cn(
							"relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
							s.status === "done" &&
								"border-primary bg-primary text-primary-foreground",
							s.status === "current" && "border-primary text-primary",
							s.status === "todo" && "border-border text-muted-foreground",
						)}
					>
						{s.status === "done" ? (
							<Check className="size-3.5" aria-hidden="true" />
						) : s.status === "current" ? (
							i + 1
						) : (
							<CircleDashed className="size-3.5" aria-hidden="true" />
						)}
					</span>
					<div className="min-w-0 flex-1">
						<p
							className={cn(
								"text-sm font-medium",
								s.status === "todo" && "text-muted-foreground",
							)}
						>
							{s.title}
							<span className="sr-only">
								{" "}
								({t(`git.stepStatus.${s.status}` as never)})
							</span>
						</p>
						{s.description ? (
							<p className="mt-0.5 text-sm text-muted-foreground">
								{s.description}
							</p>
						) : null}
						{s.status === "current" && s.action ? (
							<div className="mt-2">{s.action}</div>
						) : null}
					</div>
				</li>
			))}
		</ol>
	);
}

export interface FeatureItem {
	icon: LucideIcon;
	title: string;
	description: string;
}

/** What the feature gives you: an icon, a short title and one line each. */
export function FeatureGrid({ items }: { items: FeatureItem[] }) {
	return (
		<ul className="grid gap-3 sm:grid-cols-2">
			{items.map((f) => (
				<li key={f.title} className="flex gap-3">
					<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<f.icon className="size-4" aria-hidden="true" />
					</span>
					<div className="min-w-0">
						<p className="text-sm font-medium">{f.title}</p>
						<p className="text-sm text-muted-foreground">{f.description}</p>
					</div>
				</li>
			))}
		</ul>
	);
}

/** A titled block of a settings page. */
export function Section({
	title,
	description,
	action,
	children,
	id,
}: {
	title: string;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	id?: string;
}) {
	return (
		<section
			aria-labelledby={id ? `${id}-title` : undefined}
			className="flex flex-col gap-3"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2
						id={id ? `${id}-title` : undefined}
						className="text-base font-semibold"
					>
						{title}
					</h2>
					{description ? (
						<p className="mt-0.5 text-sm text-muted-foreground">
							{description}
						</p>
					) : null}
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
			{children}
		</section>
	);
}

/** The "nothing here yet" block: what this is, what to do, and the way to do it. */
export function EmptyState({
	icon: Icon,
	title,
	description,
	children,
}: {
	icon: LucideIcon;
	title: string;
	description: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-6 py-8 text-center">
			<span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
				<Icon className="size-5" aria-hidden="true" />
			</span>
			<div className="max-w-md">
				<p className="text-sm font-semibold">{title}</p>
				<p className="mt-1 text-sm text-muted-foreground">{description}</p>
			</div>
			{children}
		</div>
	);
}
