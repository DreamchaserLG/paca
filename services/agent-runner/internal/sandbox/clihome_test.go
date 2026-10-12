package sandbox

import (
	"context"
	"strings"
	"testing"
)

func TestEnsureCLIHomeDirs_CreatesEveryProviderDirInOneMkdir(t *testing.T) {
	backend := &fakeEnvironmentBackend{}
	if err := EnsureCLIHomeDirs(context.Background(), backend, "ref"); err != nil {
		t.Fatal(err)
	}
	if len(backend.execCmds) != 1 {
		t.Fatalf("exec calls = %d, want 1: %v", len(backend.execCmds), backend.execCmds)
	}
	got := strings.Join(backend.execCmds[0], " ")
	for _, p := range []string{"claude-code", "codex", "cursor-agent", "gemini-cli"} {
		if !strings.Contains(got, "/home/paca/workspaces/.cli-home/"+p) {
			t.Errorf("mkdir command %q is missing provider %s", got, p)
		}
	}
	if !strings.HasPrefix(got, "mkdir -p ") {
		t.Errorf("command = %q, want mkdir -p", got)
	}
}

func TestEnsureCLIHomeDirs_FailurePropagates(t *testing.T) {
	backend := &fakeEnvironmentBackend{execResults: map[string]struct {
		output   string
		exitCode int
		err      error
	}{}}
	// Any exec returns exit 1 via a catch-all: re-use a failing backend.
	failing := &failingBackend{fakeEnvironmentBackend: backend}
	if err := EnsureCLIHomeDirs(context.Background(), failing, "ref"); err == nil {
		t.Fatal("expected an error when mkdir fails")
	}
}

type failingBackend struct{ *fakeEnvironmentBackend }

func (f *failingBackend) ExecEnvironment(context.Context, string, []string) (string, int, error) {
	return "read-only filesystem", 1, nil
}
