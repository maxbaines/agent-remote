package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

const (
	repo              = "maxbaines/just-terminal"
	defaultAPIURL     = "https://api.github.com/repos/" + repo + "/releases/latest"
	downloadURLPrefix = "https://github.com/" + repo + "/releases/download/"
	checksumsAsset    = "checksums.txt"
	binaryName        = "just-terminal"
	apiURLEnv         = "JUST_TERMINAL_UPDATE_API_URL"
)

var apiClient = &http.Client{Timeout: 15 * time.Second}

// Release is a published JustTerminal release and its downloadable assets.
type Release struct {
	Tag    string
	Assets map[string]string
}

// AssetName returns the GoReleaser archive name for the running platform.
func AssetName() string {
	return fmt.Sprintf("%s_%s_%s.tar.gz", binaryName, runtime.GOOS, runtime.GOARCH)
}

func apiURL() string {
	if url := os.Getenv(apiURLEnv); url != "" {
		return url
	}
	return defaultAPIURL
}

// LatestRelease fetches the newest published release.
func LatestRelease(ctx context.Context) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL(), nil)
	if err != nil {
		return nil, fmt.Errorf("build release request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := apiClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch latest release: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("fetch latest release: unexpected status %s", resp.Status)
	}
	var payload struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode latest release: %w", err)
	}
	if payload.TagName == "" {
		return nil, fmt.Errorf("latest release has no tag_name")
	}
	release := &Release{Tag: payload.TagName, Assets: make(map[string]string, len(payload.Assets)+2)}
	for _, asset := range payload.Assets {
		if asset.Name != "" && asset.URL != "" {
			release.Assets[asset.Name] = asset.URL
		}
	}
	if len(release.Assets) == 0 {
		for _, name := range []string{AssetName(), checksumsAsset} {
			release.Assets[name] = downloadURLPrefix + payload.TagName + "/" + name
		}
	}
	return release, nil
}

// Status is returned by GET /api/update/status.
type Status struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
	CanUpdate       bool   `json:"canUpdate"`
	DevBuild        bool   `json:"devBuild"`
	Method          Method `json:"method"`
	Reason          string `json:"reason,omitempty"`
	Error           string `json:"error,omitempty"`
}

// Check resolves update status. Release lookup failures are represented in the
// payload, keeping the endpoint useful when GitHub is temporarily unavailable.
func Check(ctx context.Context, current string) (Status, *Release) {
	method, reason := Platform()
	status := Status{CurrentVersion: current, Method: method}

	// Container deployments and unsupported platforms do not need a network
	// request merely to learn that this process must not rewrite itself.
	if method == MethodContainer {
		status.Reason = reason
		return status, nil
	}
	if IsDev(current) {
		status.DevBuild = true
		status.Reason = "Development build — updates are managed by your build, not by releases."
		return status, nil
	}

	release, err := LatestRelease(ctx)
	if err != nil {
		status.Error = err.Error()
		return status, nil
	}
	status.LatestVersion = strings.TrimPrefix(release.Tag, "v")
	status.UpdateAvailable = Newer(current, release.Tag)
	status.CanUpdate = status.UpdateAvailable && method == MethodBinary
	if status.UpdateAvailable && method != MethodBinary {
		status.Reason = reason
	}
	return status, release
}
