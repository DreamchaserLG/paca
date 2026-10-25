package gitsvc

import (
	"context"

	gitdom "github.com/Paca-AI/api/internal/domain/git"
	plugindom "github.com/Paca-AI/api/internal/domain/plugin"
	"github.com/Paca-AI/api/internal/platform/gitprovider"
)

// DoerFunc adapts a function to gitprovider.Doer; production passes
// plugin.Runtime.CallInternal.
type DoerFunc func(ctx context.Context, pluginName, method, path string, body []byte) (int, []byte, error)

// Do implements gitprovider.Doer.
func (f DoerFunc) Do(ctx context.Context, pluginName, method, path string, body []byte) (int, []byte, error) {
	return f(ctx, pluginName, method, path, body)
}

// PluginProviders finds Git providers among the enabled plugins that declare
// the git-provider capability.
type PluginProviders struct {
	plugins plugindom.PluginRepository
	doer    gitprovider.Doer
}

// NewPluginProviders returns a Providers backed by the plugin registry and runtime.
func NewPluginProviders(plugins plugindom.PluginRepository, doer gitprovider.Doer) *PluginProviders {
	return &PluginProviders{plugins: plugins, doer: doer}
}

// Provider returns a client for the enabled provider plugin with the given id,
// or gitdom.ErrProviderUnavailable when no such plugin is enabled.
func (p *PluginProviders) Provider(ctx context.Context, providerID string) (ProviderAPI, error) {
	list, err := p.plugins.FindByCapability(ctx, plugindom.CapabilityGitProvider)
	if err != nil {
		return nil, err
	}
	for _, pl := range list {
		if pl.Name == providerID && pl.Enabled {
			return gitprovider.NewClient(p.doer, pl.Name), nil
		}
	}
	return nil, gitdom.ErrProviderUnavailable
}

// Describe returns the provider's Info.
func (p *PluginProviders) Describe(ctx context.Context, providerID string) (gitprovider.Info, error) {
	prov, err := p.Provider(ctx, providerID)
	if err != nil {
		return gitprovider.Info{}, err
	}
	c, ok := prov.(*gitprovider.Client)
	if !ok {
		return gitprovider.Info{}, gitdom.ErrProviderUnavailable
	}
	return c.Describe(ctx)
}

// List describes every enabled provider plugin. A provider that fails to
// answer is left out rather than failing the whole list.
func (p *PluginProviders) List(ctx context.Context) ([]gitprovider.Info, error) {
	list, err := p.plugins.FindByCapability(ctx, plugindom.CapabilityGitProvider)
	if err != nil {
		return nil, err
	}
	out := make([]gitprovider.Info, 0, len(list))
	for _, pl := range list {
		if !pl.Enabled {
			continue
		}
		if info, err := gitprovider.NewClient(p.doer, pl.Name).Describe(ctx); err == nil {
			out = append(out, info)
		}
	}
	return out, nil
}
