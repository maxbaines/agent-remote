package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const fileTreeGitTimeout = 2 * time.Second

type fileTreeEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
}

type fileTreeGit struct {
	Branch string            `json:"branch"`
	Ahead  int               `json:"ahead,omitempty"`
	Behind int               `json:"behind,omitempty"`
	Files  map[string]string `json:"files"`
}

type fileTreeResponse struct {
	Root    string          `json:"root"`
	Path    string          `json:"path"`
	Entries []fileTreeEntry `json:"entries"`
	Git     *fileTreeGit    `json:"git,omitempty"`
}

type ensureDirectoryRequest struct {
	Path string `json:"path"`
}

type ensureDirectoryResponse struct {
	Path string `json:"path"`
}

// handleDirectoryEnsure creates an absolute Session Owner directory, including
// missing parents, or confirms that it already exists. The route shares the
// terminal's authentication boundary, so it grants no filesystem authority
// beyond what the signed-in user already has through a shell pane.
func (s *Server) handleDirectoryEnsure(w http.ResponseWriter, r *http.Request) {
	var body ensureDirectoryRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	path, err := resolveRootDirectoryPath(body.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		if os.IsPermission(err) {
			http.Error(w, "root folder could not be created: permission denied", http.StatusForbidden)
			return
		}
		http.Error(w, "root folder could not be created", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(ensureDirectoryResponse{Path: path})
}

// handleFileTree returns one lazily-requested directory from the active
// terminal's local working tree. The caller supplies the pane cwd because the
// serve layer deliberately does not own sessiond's process table. When cwd is
// inside a Git work tree, the explorer roots itself at the repository root and
// includes a porcelain status snapshot for Git-aware row decoration.
func (s *Server) handleFileTree(w http.ResponseWriter, r *http.Request) {
	cwd, err := resolveFileTreeDirectory(r.URL.Query().Get("cwd"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	root, gitTree := discoverFileTreeRoot(r.Context(), cwd)
	requested := strings.TrimSpace(r.URL.Query().Get("path"))
	if requested == "" {
		requested = root
	}
	requested, err = filepath.Abs(requested)
	if err != nil {
		http.Error(w, "invalid directory path", http.StatusBadRequest)
		return
	}
	requested = filepath.Clean(requested)
	if !pathWithinRoot(root, requested) {
		http.Error(w, "directory is outside the file-tree root", http.StatusBadRequest)
		return
	}

	entries, err := listFileTreeDirectory(requested, r.URL.Query().Get("hidden") == "1")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "directory not found", http.StatusNotFound)
			return
		}
		http.Error(w, "could not read directory", http.StatusForbidden)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(fileTreeResponse{
		Root:    root,
		Path:    requested,
		Entries: entries,
		Git:     gitTree,
	})
}

func resolveFileTreeDirectory(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.IndexByte(raw, 0) >= 0 {
		return "", errors.New("pane working directory is required")
	}
	expanded, err := expandViewerHome(raw)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(expanded) {
		return "", errors.New("pane working directory must be absolute")
	}
	path := filepath.Clean(expanded)
	info, err := os.Stat(path)
	if err != nil {
		return "", errors.New("pane working directory was not found")
	}
	if !info.IsDir() {
		return "", errors.New("pane working directory is not a directory")
	}
	return path, nil
}

func resolveRootDirectoryPath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.IndexByte(raw, 0) >= 0 {
		return "", errors.New("root folder is required")
	}
	expanded, err := expandViewerHome(raw)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(expanded) {
		return "", errors.New("root folder must be absolute")
	}
	return filepath.Clean(expanded), nil
}

func discoverFileTreeRoot(parent context.Context, cwd string) (string, *fileTreeGit) {
	ctx, cancel := context.WithTimeout(parent, fileTreeGitTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return cwd, nil
	}
	root := filepath.Clean(strings.TrimSpace(string(output)))
	if root == "" || !filepath.IsAbs(root) {
		return cwd, nil
	}
	return root, readFileTreeGitStatus(parent, root)
}

func readFileTreeGitStatus(parent context.Context, root string) *fileTreeGit {
	ctx, cancel := context.WithTimeout(parent, fileTreeGitTimeout)
	defer cancel()
	output, err := exec.CommandContext(
		ctx,
		"git", "-C", root,
		"status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--ignored=no",
	).Output()
	if err != nil {
		return &fileTreeGit{Files: map[string]string{}}
	}
	return parseFileTreeGitStatus(output)
}

func parseFileTreeGitStatus(output []byte) *fileTreeGit {
	result := &fileTreeGit{Files: make(map[string]string)}
	records := bytes.Split(output, []byte{0})
	for i := 0; i < len(records); i++ {
		record := string(records[i])
		if record == "" {
			continue
		}
		if strings.HasPrefix(record, "## ") {
			result.Branch, result.Ahead, result.Behind = parseFileTreeBranch(strings.TrimPrefix(record, "## "))
			continue
		}
		if len(record) < 4 || record[2] != ' ' {
			continue
		}
		status := record[:2]
		path := filepath.ToSlash(strings.TrimPrefix(record[3:], "./"))
		if path != "" {
			result.Files[path] = status
		}
		// In porcelain v1 -z output, rename/copy records are followed by a
		// second NUL-delimited source path. The first path above is the current
		// destination and therefore the one the explorer should decorate.
		if strings.ContainsAny(status, "RC") && i+1 < len(records) {
			i++
		}
	}
	return result
}

func parseFileTreeBranch(header string) (string, int, int) {
	branch := strings.TrimSpace(header)
	for _, prefix := range []string{"No commits yet on ", "Initial commit on "} {
		branch = strings.TrimPrefix(branch, prefix)
	}
	if split := strings.Index(branch, "..."); split >= 0 {
		branch = branch[:split]
	} else if split := strings.IndexByte(branch, ' '); split >= 0 {
		branch = branch[:split]
	}
	ahead := branchCount(header, "ahead ")
	behind := branchCount(header, "behind ")
	return branch, ahead, behind
}

func branchCount(header, label string) int {
	start := strings.Index(header, label)
	if start < 0 {
		return 0
	}
	start += len(label)
	end := start
	for end < len(header) && header[end] >= '0' && header[end] <= '9' {
		end++
	}
	count, _ := strconv.Atoi(header[start:end])
	return count
}

func pathWithinRoot(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func listFileTreeDirectory(path string, showHidden bool) ([]fileTreeEntry, error) {
	dirEntries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	entries := make([]fileTreeEntry, 0, len(dirEntries))
	for _, entry := range dirEntries {
		name := entry.Name()
		if name == ".git" || (!showHidden && strings.HasPrefix(name, ".")) {
			continue
		}
		fullPath := filepath.Join(path, name)
		isDirectory := entry.IsDir()
		if entry.Type()&os.ModeSymlink != 0 {
			if info, statErr := os.Stat(fullPath); statErr == nil {
				isDirectory = info.IsDir()
			}
		}
		entries = append(entries, fileTreeEntry{
			Name:      name,
			Path:      fullPath,
			Directory: isDirectory,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Directory != entries[j].Directory {
			return entries[i].Directory
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}
