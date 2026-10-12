import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { projectMembersQueryOptions } from "@/lib/project-api";
import { type AvatarIdentity, memberAvatar } from "@/lib/provider-logos";

interface ActorRef {
	/** A project member id or the account (user/agent/service account) id. */
	id?: string | null;
	name?: string | null;
	username?: string | null;
	/** The avatar the payload itself carried, used when the actor is no
	 * longer a member of the project. */
	avatarUrl?: string | null;
}

/**
 * Feeds (activity logs, comment threads) only carry an actor's name and
 * uploaded avatar, not whether the actor is a human, an agent or a service
 * account — and so can't pick the right default avatar. This resolves the
 * actor against the project's (already cached) member list; an actor that
 * isn't a member any more falls back to a plain human identity.
 */
export function useActorAvatar(projectId: string) {
	const { data: members = [] } = useQuery(
		projectMembersQueryOptions(projectId),
	);
	return useCallback(
		(actor: ActorRef): AvatarIdentity => {
			const member = actor.id
				? members.find((m) => m.id === actor.id || m.user_id === actor.id)
				: undefined;
			if (member) return memberAvatar(member);
			return {
				name: actor.name || actor.username || "",
				type: "human",
				avatarUrl: actor.avatarUrl,
			};
		},
		[members],
	);
}
