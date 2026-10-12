package sandbox

import (
	"context"
	"fmt"
	"strings"

	"github.com/Paca-AI/agent-runner/internal/executor/providercli"
)

// EnsureCLIHomeDirs creates every provider CLI's persisted home directory
// (providercli.HomeRoot/<provider>) on an environment's workspace volume.
// services/agent-server's image bakes ~/.claude, ~/.codex, ~/.cursor and
// ~/.gemini as symlinks onto those directories, but the volume is mounted at
// runtime, so the targets can't exist in the image. Without them a login made
// from the environment terminal before any conversation has run would hit a
// dangling symlink. Idempotent; safe to call on every create/start.
func EnsureCLIHomeDirs(ctx context.Context, backend EnvironmentBackend, backendRef string) error {
	cmd := []string{"mkdir", "-p"}
	for _, a := range providercli.All() {
		cmd = append(cmd, providercli.HomeRoot+"/"+a.Name())
	}
	if err := execEnvironmentOK(ctx, backend, backendRef, cmd); err != nil {
		return fmt.Errorf("sandbox: create cli home dirs (%s): %w", strings.Join(cmd[2:], " "), err)
	}
	return nil
}
