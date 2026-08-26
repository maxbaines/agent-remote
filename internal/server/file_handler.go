package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const maxViewerFileBytes = 3 << 20

type viewerFileResponse struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// handleFileRead serves a bounded, read-only view of a local UTF-8 text file.
// The route uses the same authentication boundary as the terminal itself. A
// terminal-reported cwd may be supplied so relative paths resolve exactly as
// they did in the pane where the user Shift-clicked the link.
func (s *Server) handleFileRead(w http.ResponseWriter, r *http.Request) {
	path, err := resolveViewerPath(r.URL.Query().Get("path"), r.URL.Query().Get("cwd"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		http.Error(w, "could not open file", http.StatusForbidden)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "path is not a regular file", http.StatusBadRequest)
		return
	}
	if info.Size() > maxViewerFileBytes {
		http.Error(w, "file is too large to preview (3 MiB maximum)", http.StatusRequestEntityTooLarge)
		return
	}

	data, err := io.ReadAll(io.LimitReader(f, maxViewerFileBytes+1))
	if err != nil {
		http.Error(w, "could not read file", http.StatusInternalServerError)
		return
	}
	if len(data) > maxViewerFileBytes {
		http.Error(w, "file is too large to preview (3 MiB maximum)", http.StatusRequestEntityTooLarge)
		return
	}
	if !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		http.Error(w, "binary files cannot be previewed", http.StatusUnsupportedMediaType)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(viewerFileResponse{Path: path, Content: string(data)})
}

func resolveViewerPath(rawPath, rawCWD string) (string, error) {
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" || strings.IndexByte(rawPath, 0) >= 0 {
		return "", fmt.Errorf("file path is required")
	}

	if strings.HasPrefix(rawPath, "file://") {
		u, err := url.Parse(rawPath)
		if err != nil || u.Path == "" {
			return "", fmt.Errorf("invalid file URL")
		}
		rawPath = u.Path
	}

	expanded, err := expandViewerHome(rawPath)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(expanded) {
		return filepath.Clean(expanded), nil
	}

	var bases []string
	if rawCWD != "" {
		cwd, err := expandViewerHome(rawCWD)
		if err == nil && filepath.IsAbs(cwd) {
			bases = append(bases, cwd)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		bases = append(bases, cwd)
	}
	if home, err := os.UserHomeDir(); err == nil {
		bases = append(bases, home)
	}

	for _, base := range bases {
		candidate := filepath.Clean(filepath.Join(base, expanded))
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate, nil
		}
	}
	if len(bases) == 0 {
		return "", fmt.Errorf("could not resolve relative file path")
	}
	return filepath.Clean(filepath.Join(bases[0], expanded)), nil
}

func expandViewerHome(path string) (string, error) {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("could not resolve home directory")
	}
	if path == "~" {
		return home, nil
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~/")), nil
}
