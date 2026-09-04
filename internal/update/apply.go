package update

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	maxAssetBytes    = 256 << 20
	maxBinaryBytes   = 256 << 20
	maxChecksumBytes = 1 << 20
)

var downloadClient = &http.Client{Timeout: 10 * time.Minute}

// Apply downloads, verifies, and atomically installs rel over the running binary.
func Apply(ctx context.Context, rel *Release) error {
	if rel == nil {
		return errors.New("no release to apply")
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate running binary: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return fmt.Errorf("resolve running binary path %s: %w", exe, err)
	}
	dir := filepath.Dir(exe)
	asset := AssetName()
	assetURL, ok := rel.Assets[asset]
	if !ok {
		return fmt.Errorf("release %s has no asset %q", rel.Tag, asset)
	}
	sumsURL, ok := rel.Assets[checksumsAsset]
	if !ok {
		return fmt.Errorf("release %s has no asset %q", rel.Tag, checksumsAsset)
	}

	tmpTar, err := os.CreateTemp(dir, ".just-terminal-update-*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tarPath := tmpTar.Name()
	defer func() { _ = os.Remove(tarPath) }()
	defer func() { _ = tmpTar.Close() }()

	got, err := downloadAndHash(ctx, assetURL, tmpTar)
	if err != nil {
		return fmt.Errorf("download %s: %w", asset, err)
	}
	if err := tmpTar.Close(); err != nil {
		return fmt.Errorf("write %s: %w", asset, err)
	}
	want, err := fetchChecksum(ctx, sumsURL, asset)
	if err != nil {
		return err
	}
	if !strings.EqualFold(want, got) {
		return fmt.Errorf("checksum mismatch for %s: manifest has %s, download hashed to %s", asset, want, got)
	}

	tmpBin, err := extractBinary(tarPath, dir)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmpBin) }()
	if err := os.Rename(tmpBin, exe); err != nil {
		return fmt.Errorf("install new binary over %s: %w", exe, err)
	}
	return nil
}

func downloadAndHash(ctx context.Context, url string, dst io.Writer) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	resp, err := downloadClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("unexpected status %s", resp.Status)
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(dst, hash), io.LimitReader(resp.Body, maxAssetBytes+1))
	if err != nil {
		return "", fmt.Errorf("copy body: %w", err)
	}
	if n > maxAssetBytes {
		return "", fmt.Errorf("asset exceeds %d bytes", int64(maxAssetBytes))
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func fetchChecksum(ctx context.Context, url, asset string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build %s request: %w", checksumsAsset, err)
	}
	resp, err := downloadClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", checksumsAsset, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("download %s: unexpected status %s", checksumsAsset, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxChecksumBytes+1))
	if err != nil {
		return "", fmt.Errorf("read %s: %w", checksumsAsset, err)
	}
	if len(body) > maxChecksumBytes {
		return "", fmt.Errorf("%s exceeds %d bytes", checksumsAsset, maxChecksumBytes)
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.TrimPrefix(fields[1], "*") == asset {
			if len(fields[0]) != sha256.Size*2 {
				return "", fmt.Errorf("%s has an invalid checksum for %s", checksumsAsset, asset)
			}
			if _, err := hex.DecodeString(fields[0]); err != nil {
				return "", fmt.Errorf("%s has an invalid checksum for %s", checksumsAsset, asset)
			}
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("%s has no entry for %s", checksumsAsset, asset)
}

func extractBinary(tarPath, destDir string) (string, error) {
	f, err := os.Open(tarPath)
	if err != nil {
		return "", fmt.Errorf("open downloaded archive: %w", err)
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("read gzip archive: %w", err)
	}
	defer func() { _ = gz.Close() }()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read tar archive: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg || unsafeTarPath(hdr.Name) || filepath.Base(filepath.FromSlash(hdr.Name)) != binaryName {
			continue
		}
		out, err := os.CreateTemp(destDir, ".just-terminal-update-bin-*")
		if err != nil {
			return "", fmt.Errorf("create temp file in %s: %w", destDir, err)
		}
		outPath := out.Name()
		n, copyErr := io.Copy(out, io.LimitReader(tr, maxBinaryBytes+1))
		closeErr := out.Close()
		switch {
		case copyErr != nil:
			_ = os.Remove(outPath)
			return "", fmt.Errorf("extract %s: %w", binaryName, copyErr)
		case closeErr != nil:
			_ = os.Remove(outPath)
			return "", fmt.Errorf("write %s: %w", binaryName, closeErr)
		case n > maxBinaryBytes:
			_ = os.Remove(outPath)
			return "", fmt.Errorf("extract %s: exceeds %d bytes", binaryName, int64(maxBinaryBytes))
		}
		if err := os.Chmod(outPath, 0o755); err != nil {
			_ = os.Remove(outPath)
			return "", fmt.Errorf("chmod %s: %w", outPath, err)
		}
		return outPath, nil
	}
	return "", fmt.Errorf("archive does not contain a %q binary", binaryName)
}

func unsafeTarPath(name string) bool {
	if strings.HasPrefix(name, "/") {
		return true
	}
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

// Restart activates the new Gateway binary without disrupting the existing
// Session Owner. This fork does not yet restore live PTYs after a daemon
// restart, so preserving the daemon is safer than forcing version alignment.
func Restart() error {
	if os.Getenv("INVOCATION_ID") != "" {
		cmd := exec.Command("systemctl", "--user", "restart", "just-terminal.service")
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("systemctl --user restart just-terminal.service: %w", err)
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate running binary: %w", err)
	}
	log.Printf("update: preserving the running sessiond because session restore is unavailable")
	if err := syscall.Exec(exe, os.Args, os.Environ()); err != nil {
		return fmt.Errorf("re-exec %s: %w", exe, err)
	}
	return nil
}
