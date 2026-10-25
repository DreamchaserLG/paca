#!/bin/bash
# Spike S1 probe: can a GitHub App's bot be requested as a reviewer or assigned?
# Read-only checks (safe to run); needs `gh` authenticated with read access.
#
#   ./probe.sh <owner/repo> <bot-login>      e.g. ./probe.sh acme/web 'my-paca-app[bot]'
#
# Reviewer requests require the target to be a collaborator (422 otherwise), and
# issue assignees must be assignable. Both are checked without changing anything.
set -u
repo=${1:?owner/repo}; bot=${2:?bot login, e.g. my-app[bot]}
st() { gh api "$@" -i 2>&1 | head -1; }

echo "collaborator?  GET repos/$repo/collaborators/$bot   -> $(st "repos/$repo/collaborators/$bot")"
echo "assignable?    GET repos/$repo/assignees/$bot        -> $(st "repos/$repo/assignees/$bot")"
echo "GraphQL assignable actors (first 20 bots/users):"
owner=${repo%/*}; name=${repo#*/}
gh api graphql -H 'GraphQL-Features: issues_copilot_assignment_api_support' -f query="query{repository(owner:\"$owner\",name:\"$name\"){suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:20){nodes{__typename ... on Bot{login} ... on User{login}}}}}" \
  --jq '.data.repository.suggestedActors.nodes[] | "  \(.__typename)\t\(.login)"' 2>&1
echo
echo "Interpretation: 200/204 on the first two, or the bot listed in GraphQL, means the trigger is feasible."
echo "404 on both and absent from GraphQL means review_request/assignment must stay undeclared for this identity."
