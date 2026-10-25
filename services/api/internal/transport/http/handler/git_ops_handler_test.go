package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	gitdom "github.com/Paca-AI/api/internal/domain/git"
	"github.com/Paca-AI/api/internal/platform/gitprovider"
	gitsvc "github.com/Paca-AI/api/internal/service/git"
	"github.com/Paca-AI/api/internal/transport/http/middleware"
)

// fakeOps embeds the interface so only the methods a test touches are written.
type fakeOps struct {
	GitOps
	scope   gitsvc.Scope
	claimed string
	number  string
	thread  string
	body    string
	review  gitsvc.ReviewInput
	kind    gitprovider.SubjectKind
	err     error

	settings *gitdom.ProjectSettings
	trigger  string
	limit    int
}

func (f *fakeOps) NewScope(_ context.Context, p, r, a uuid.UUID, claimed string) gitsvc.Scope {
	f.claimed = claimed
	return gitsvc.Scope{ProjectID: p, RepositoryID: r, AgentID: a}
}
func (f *fakeOps) GetChangeRequestContext(_ context.Context, sc gitsvc.Scope, n string) (*gitsvc.ChangeRequestContext, error) {
	f.scope, f.number = sc, n
	if f.err != nil {
		return nil, f.err
	}
	return &gitsvc.ChangeRequestContext{ChangeRequest: gitprovider.ChangeRequest{Number: n, Title: "t"}}, nil
}
func (f *fakeOps) PostComment(_ context.Context, sc gitsvc.Scope, k gitprovider.SubjectKind, n, body string) (gitprovider.CommentResult, error) {
	f.scope, f.kind, f.number, f.body = sc, k, n, body
	return gitprovider.CommentResult{ID: "c1"}, f.err
}
func (f *fakeOps) ReplyThread(_ context.Context, sc gitsvc.Scope, n, th, body string) (gitprovider.CommentResult, error) {
	f.scope, f.number, f.thread, f.body = sc, n, th, body
	return gitprovider.CommentResult{ID: "c2"}, f.err
}
func (f *fakeOps) SubmitReview(_ context.Context, sc gitsvc.Scope, n string, in gitsvc.ReviewInput) (gitprovider.ReviewResult, error) {
	f.scope, f.number, f.review = sc, n, in
	return gitprovider.ReviewResult{ID: "r1", Posted: len(in.Comments)}, f.err
}
func (f *fakeOps) GetProjectSettings(_ context.Context, p uuid.UUID) (*gitdom.ProjectSettings, error) {
	return &gitdom.ProjectSettings{ProjectID: p, MinActorPermission: "write"}, f.err
}
func (f *fakeOps) SetProjectSettings(_ context.Context, st *gitdom.ProjectSettings) (*gitdom.ProjectSettings, error) {
	f.settings = st
	return st, f.err
}
func (f *fakeOps) ListAgentTriggers(context.Context, uuid.UUID) ([]gitsvc.TriggerView, error) {
	return []gitsvc.TriggerView{{Kind: gitdom.TriggerMention, Enabled: true}}, f.err
}
func (f *fakeOps) SetAgentTrigger(_ context.Context, a uuid.UUID, k gitdom.TriggerKind, on bool, cfg json.RawMessage) error {
	f.trigger = fmt.Sprintf("%s/%s/%v/%s", a, k, on, cfg)
	return f.err
}
func (f *fakeOps) ListProjectRuns(_ context.Context, _ uuid.UUID, limit int) ([]*gitdom.ProjectRun, error) {
	f.limit = limit
	return []*gitdom.ProjectRun{{Run: gitdom.Run{Trigger: gitdom.TriggerMention, Status: gitdom.RunRunning}, RepositoryPath: "acme/web"}}, f.err
}
func (f *fakeOps) RerunChecks(context.Context, gitsvc.Scope, string, string) error { return f.err }

func serveOps(t *testing.T, f *fakeOps, method, target, body string, actor *uuid.UUID, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewGitHandler(&fakeGitSvc{}).WithAgentLookup(agentLookup).WithOps(f)
	r := chi.NewRouter()
	base := "/projects/{projectId}/git/repositories/{repositoryId}"
	r.Get(base+"/change-requests/{number}", h.GetChangeRequest)
	r.Post(base+"/change-requests/{number}/reviews", h.SubmitReview)
	r.Post(base+"/change-requests/{number}/approvals", h.ApproveChangeRequest)
	r.Post(base+"/change-requests/{number}/threads/{threadId}/replies", h.ReplyThread)
	r.Post(base+"/subjects/{kind}/{number}/comments", h.PostComment)
	r.Post(base+"/checks/rerun", h.RerunChecks)
	r.Get("/projects/{projectId}/git/settings", h.GetSettings)
	r.Put("/projects/{projectId}/git/settings", h.PutSettings)
	r.Get("/projects/{projectId}/git/runs", h.ListProjectRuns)
	r.Get("/projects/{projectId}/agents/{agentId}/git/triggers", h.ListAgentTriggers)
	r.Put("/projects/{projectId}/agents/{agentId}/git/triggers/{kind}", h.SetAgentTrigger)
	req := httptest.NewRequestWithContext(t.Context(), method, target, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	if actor != nil {
		req = req.WithContext(middleware.WithActorID(req.Context(), *actor))
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestGitOpsHandler_ScopeComesFromTheRouteAndTheAuthenticatedAccount(t *testing.T) {
	agent, project, repo := uuid.New(), uuid.New(), uuid.New()
	base := fmt.Sprintf("/projects/%s/git/repositories/%s", project, repo)
	f := &fakeOps{}
	rec := serveOps(t, f, "GET", base+"/change-requests/42", "", &agent, map[string]string{conversationHeader: "conv-1"})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"number":"42"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if f.scope.ProjectID != project || f.scope.RepositoryID != repo || f.scope.AgentID != agent || f.number != "42" || f.claimed != "conv-1" {
		t.Fatalf("scope = %+v number = %q claimed = %q", f.scope, f.number, f.claimed)
	}
	// No authenticated account: refused before the service is reached.
	if rec := serveOps(t, &fakeOps{}, "GET", base+"/change-requests/42", "", nil, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", rec.Code)
	}
	if rec := serveOps(t, &fakeOps{}, "GET", fmt.Sprintf("/projects/%s/git/repositories/nope/change-requests/1", project), "", &agent, nil); rec.Code != 400 {
		t.Fatalf("bad repository id: %d", rec.Code)
	}
}

func TestGitOpsHandler_ReviewsCannotApproveAndApprovalsAlwaysApprove(t *testing.T) {
	agent, project, repo := uuid.New(), uuid.New(), uuid.New()
	base := fmt.Sprintf("/projects/%s/git/repositories/%s/change-requests/7", project, repo)
	f := &fakeOps{}

	// The verdict is decided by the route (and so by its gate), never the body.
	if rec := serveOps(t, f, "POST", base+"/reviews", `{"verdict":"approve","summary":"ship it"}`, &agent, nil); rec.Code != 400 {
		t.Fatalf("approving through /reviews must be refused: %d %s", rec.Code, rec.Body)
	}
	if rec := serveOps(t, f, "POST", base+"/reviews", `{"summary":"notes","head_sha":"abc","comments":[{"path":"a.go","line":3,"body":"x"}]}`, &agent, nil); rec.Code != 200 {
		t.Fatalf("default verdict: %d %s", rec.Code, rec.Body)
	}
	if f.review.Verdict != gitprovider.VerdictComment || f.review.HeadSHA != "abc" || len(f.review.Comments) != 1 || f.review.Comments[0].Path != "a.go" {
		t.Fatalf("review = %+v", f.review)
	}
	if rec := serveOps(t, f, "POST", base+"/reviews", `{"verdict":"request_changes","summary":"no"}`, &agent, nil); rec.Code != 200 || f.review.Verdict != gitprovider.VerdictRequestChanges {
		t.Fatalf("request_changes: %d %+v", rec.Code, f.review)
	}
	if rec := serveOps(t, f, "POST", base+"/approvals", `{"verdict":"request_changes","summary":"lgtm"}`, &agent, nil); rec.Code != 200 || f.review.Verdict != gitprovider.VerdictApprove {
		t.Fatalf("a body verdict must not override the route: %d %+v", rec.Code, f.review)
	}
}

func TestGitOpsHandler_CommentsAndReplies(t *testing.T) {
	agent, project, repo := uuid.New(), uuid.New(), uuid.New()
	base := fmt.Sprintf("/projects/%s/git/repositories/%s", project, repo)
	f := &fakeOps{}
	if rec := serveOps(t, f, "POST", base+"/subjects/issue/9/comments", `{"body":"hello"}`, &agent, nil); rec.Code != 200 || f.kind != gitprovider.SubjectIssue || f.number != "9" || f.body != "hello" {
		t.Fatalf("comment: %d kind=%q number=%q body=%q", rec.Code, f.kind, f.number, f.body)
	}
	if rec := serveOps(t, f, "POST", base+"/subjects/pull/9/comments", `{"body":"hello"}`, &agent, nil); rec.Code != 400 {
		t.Fatalf("unknown subject kind: %d", rec.Code)
	}
	if rec := serveOps(t, f, "POST", base+"/change-requests/7/threads/PRRT_x/replies", `{"body":"done"}`, &agent, nil); rec.Code != 200 || f.thread != "PRRT_x" || f.number != "7" {
		t.Fatalf("reply: %d thread=%q", rec.Code, f.thread)
	}
}

func TestGitOpsHandler_ErrorMapping(t *testing.T) {
	agent, project, repo := uuid.New(), uuid.New(), uuid.New()
	url := fmt.Sprintf("/projects/%s/git/repositories/%s/change-requests/1", project, repo)
	cases := []struct {
		err        error
		status     int
		code       string
		bodyHas    string
		bodyHasNot string
	}{
		{fmt.Errorf("%w: title is required", gitdom.ErrInvalidInput), 400, "BAD_REQUEST", "title is required", ""},
		{gitdom.ErrUnsupported, 400, "BAD_REQUEST", "does not support", ""},
		{gitdom.ErrRateLimited, 429, "TOO_MANY_REQUESTS", "", ""},
		{gitdom.ErrNotFound, 404, "GIT_NOT_FOUND", "", ""},
		{gitdom.ErrNoIdentity, 409, "GIT_NO_IDENTITY", "", ""},
		{&gitprovider.Error{Code: gitprovider.CodeValidation, Message: "head branch not found"}, 400, "BAD_REQUEST", "head branch not found", ""},
		{&gitprovider.Error{Code: gitprovider.CodeForbidden, Message: "token ghs_secret lacks scope"}, 502, "GIT_PROVIDER_REJECTED", "", "ghs_secret"},
		{&gitprovider.Error{Code: gitprovider.CodeNotFound, Message: "no such pr"}, 404, "GIT_NOT_FOUND", "", "no such pr"},
	}
	for _, c := range cases {
		rec := serveOps(t, &fakeOps{err: c.err}, "GET", url, "", &agent, nil)
		if errCode(rec) != c.code || (c.bodyHas != "" && !strings.Contains(rec.Body.String(), c.bodyHas)) || (c.bodyHasNot != "" && strings.Contains(rec.Body.String(), c.bodyHasNot)) {
			t.Errorf("%v: %d %s", c.err, rec.Code, rec.Body)
		}
	}
}

func TestGitOpsHandler_LongProviderDetailIsCapped(t *testing.T) {
	agent, project, repo := uuid.New(), uuid.New(), uuid.New()
	url := fmt.Sprintf("/projects/%s/git/repositories/%s/change-requests/1", project, repo)
	long := strings.Repeat("x", 5000)
	rec := serveOps(t, &fakeOps{err: &gitprovider.Error{Code: gitprovider.CodeValidation, Message: long}}, "GET", url, "", &agent, nil)
	if rec.Code != 400 || rec.Body.Len() > 1500 {
		t.Fatalf("%d, body %d bytes", rec.Code, rec.Body.Len())
	}
}

func TestGitOpsHandler_SettingsTriggersAndRuns(t *testing.T) {
	actor, project, agent := uuid.New(), uuid.New(), uuid.New()
	prev := agentLookup
	agentLookup = fakeAgents{project: project, agent: agent}
	defer func() { agentLookup = prev }()
	f := &fakeOps{}
	base := "/projects/" + project.String()

	if rec := serveOps(t, f, "GET", base+"/git/settings", "", &actor, nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"min_actor_permission":"write"`) {
		t.Fatalf("get settings: %d %s", rec.Code, rec.Body)
	}
	body := fmt.Sprintf(`{"default_responder_agent_id":%q,"paused":true,"min_actor_permission":" triage "}`, agent)
	if rec := serveOps(t, f, "PUT", base+"/git/settings", body, &actor, nil); rec.Code != 200 {
		t.Fatalf("put settings: %d %s", rec.Code, rec.Body)
	}
	if f.settings.ProjectID != project || !f.settings.Paused || f.settings.MinActorPermission != "triage" || *f.settings.DefaultResponderAgentID != agent {
		t.Fatalf("settings = %+v", f.settings)
	}

	if rec := serveOps(t, f, "GET", base+"/git/runs?limit=7", "", &actor, nil); rec.Code != 200 || f.limit != 7 || !strings.Contains(rec.Body.String(), "acme/web") {
		t.Fatalf("runs: %d limit=%d %s", rec.Code, f.limit, rec.Body)
	}

	tr := base + "/agents/" + agent.String() + "/git/triggers"
	if rec := serveOps(t, f, "GET", tr, "", &actor, nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "mention") {
		t.Fatalf("triggers: %d %s", rec.Code, rec.Body)
	}
	if rec := serveOps(t, f, "PUT", tr+"/auto_review", `{"enabled":true,"config":{"branches":["main"]}}`, &actor, nil); rec.Code != 200 || f.trigger != agent.String()+`/auto_review/true/{"branches":["main"]}` {
		t.Fatalf("set trigger: %d %q", rec.Code, f.trigger)
	}
	// An agent that is not one of this project's agents is not found.
	if rec := serveOps(t, f, "PUT", base+"/agents/"+uuid.NewString()+"/git/triggers/mention", `{"enabled":false}`, &actor, nil); rec.Code != 404 {
		t.Fatalf("foreign agent: %d", rec.Code)
	}
	f.err = fmt.Errorf("%w: min_actor_permission must be read", gitdom.ErrInvalidInput)
	if rec := serveOps(t, f, "PUT", base+"/git/settings", `{}`, &actor, nil); rec.Code != 400 || !strings.Contains(rec.Body.String(), "min_actor_permission") {
		t.Fatalf("validation: %d %s", rec.Code, rec.Body)
	}
}
