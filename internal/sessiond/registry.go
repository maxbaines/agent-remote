package sessiond

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// Workspace is one daemon-managed workspace. Its panes use workspace-local ids
// allocated by the Registry, independent of any other workspace.
type Workspace struct {
	ID         string            // daemon-allocated, e.g. "w1"
	Name       string            // optional label; "" means unnamed
	ClientRef  string            // client-minted optimistic-create correlation id; "" when none
	Panes      map[int]*Pane     // keyed by workspace-local pane id
	Layouts    map[string]string // breakpoint label -> opaque dockview layout JSON
	nextPaneID int

	generation           uint64
	membershipGeneration uint64
}

// Registry is the single source of truth for workspaces and their panes. All
// access is serialized by mu so concurrent control connections see a consistent
// view.
type Registry struct {
	mu                      sync.Mutex
	workspaces              map[string]*Workspace
	nextWSID                int
	nextWorkspaceGeneration uint64
	nextPaneGeneration      uint64
	statePath               string

	closeTickets        map[string]closeTicket
	retiredCloseTickets map[string]retiredCloseTicket
	closeTicketSequence uint64
}

type persistedRegistry struct {
	NextWSID   int                  `json:"nextWorkspaceId"`
	Workspaces []persistedWorkspace `json:"workspaces"`
}

type persistedWorkspace struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

// NewRegistry returns an empty Registry ready for use.
func NewRegistry() *Registry {
	return &Registry{
		workspaces:          make(map[string]*Workspace),
		closeTickets:        make(map[string]closeTicket),
		retiredCloseTickets: make(map[string]retiredCloseTicket),
	}
}

// NewPersistentRegistry restores workspace identity and names from path. Pane
// processes and layouts deliberately remain session-lifetime state, so every
// restored workspace starts empty after a daemon/container restart.
func NewPersistentRegistry(path string) (*Registry, error) {
	r := NewRegistry()
	r.statePath = path
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read workspace state: %w", err)
	}
	var state persistedRegistry
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode workspace state: %w", err)
	}
	for _, saved := range state.Workspaces {
		if saved.ID == "" {
			continue
		}
		r.nextWorkspaceGeneration++
		r.workspaces[saved.ID] = &Workspace{
			ID: saved.ID, Name: saved.Name,
			Panes: make(map[int]*Pane), Layouts: make(map[string]string),
			generation: r.nextWorkspaceGeneration,
		}
	}
	r.nextWSID = state.NextWSID
	return r, nil
}

// persistLocked atomically records only the durable sidebar model. Runtime
// pane and layout state is intentionally excluded.
func (r *Registry) persistLocked() error {
	if r.statePath == "" {
		return nil
	}
	state := persistedRegistry{NextWSID: r.nextWSID}
	for _, ws := range r.workspaces {
		state.Workspaces = append(state.Workspaces, persistedWorkspace{ID: ws.ID, Name: ws.Name})
	}
	sort.Slice(state.Workspaces, func(i, j int) bool { return state.Workspaces[i].ID < state.Workspaces[j].ID })
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.statePath), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(r.statePath), ".workspaces-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, r.statePath)
}

func (r *Registry) persistBestEffortLocked() {
	if err := r.persistLocked(); err != nil {
		log.Printf("sessiond: persist workspace state: %v", err)
	}
}

// addWorkspaceLocked allocates a new workspace id, inserts the workspace, and
// returns its id. The caller must hold r.mu. It is shared by AddWorkspace and
// the lifecycle helpers in workspace.go.
func (r *Registry) addWorkspaceLocked(name, clientRef string) string {
	r.nextWSID++
	r.nextWorkspaceGeneration++
	id := fmt.Sprintf("w%d", r.nextWSID)
	r.workspaces[id] = &Workspace{
		ID:         id,
		Name:       name,
		ClientRef:  clientRef,
		Panes:      make(map[int]*Pane),
		Layouts:    make(map[string]string),
		generation: r.nextWorkspaceGeneration,
	}
	return id
}

// AddWorkspace creates a new workspace with the given name and returns its
// daemon-allocated id.
func (r *Registry) AddWorkspace(name, clientRef string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := r.addWorkspaceLocked(name, clientRef)
	r.persistBestEffortLocked()
	return id
}

// Get returns the workspace for id and whether it exists.
func (r *Registry) Get(id string) (*Workspace, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[id]
	return ws, ok
}

// Has reports whether a workspace with id exists.
func (r *Registry) Has(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.workspaces[id]
	return ok
}

// List returns a deterministic snapshot of all workspaces, sorted by
// WorkspaceID.
func (r *Registry) List() []WorkspaceInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]WorkspaceInfo, 0, len(r.workspaces))
	for _, ws := range r.workspaces {
		out = append(out, WorkspaceInfo{
			WorkspaceID: ws.ID,
			Name:        ws.Name,
			ClientRef:   ws.ClientRef,
			PaneCount:   len(ws.Panes),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].WorkspaceID < out[j].WorkspaceID
	})
	return out
}

// AllocPaneID reserves and returns the next workspace-local pane id (starting at
// 1) for wsID. The second return is false for an unknown workspace.
func (r *Registry) AllocPaneID(wsID string) (int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return 0, false
	}
	ws.nextPaneID++
	return ws.nextPaneID, true
}

// PutPane inserts p into wsID keyed by p.LocalID. It returns false for an
// unknown workspace.
func (r *Registry) PutPane(wsID string, p *Pane) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok || p == nil {
		return false
	}
	r.nextPaneGeneration++
	p.targetGeneration = r.nextPaneGeneration
	ws.Panes[p.LocalID] = p
	ws.membershipGeneration++
	return true
}

// Pane returns the pane paneID within wsID and whether it exists.
func (r *Registry) Pane(wsID string, paneID int) (*Pane, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil, false
	}
	p, ok := ws.Panes[paneID]
	return p, ok
}

// PaneIDs returns a deterministic sorted snapshot of the pane ids in wsID, or
// nil for an unknown workspace.
func (r *Registry) PaneIDs(wsID string) []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil
	}
	ids := make([]int, 0, len(ws.Panes))
	for id := range ws.Panes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}

// PaneInfos returns a deterministic sorted snapshot of frozen PaneInfo values
// for wsID's panes (built via Pane.Info()), or nil for an unknown workspace.
//
// Pane.Info() takes the pane's own mu while r.mu is held; this is safe because
// Pane.Info() never calls back into the Registry, so there is no lock cycle.
func (r *Registry) PaneInfos(wsID string) []PaneInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil
	}
	ids := make([]int, 0, len(ws.Panes))
	for id := range ws.Panes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	infos := make([]PaneInfo, 0, len(ids))
	for _, id := range ids {
		infos = append(infos, ws.Panes[id].Info())
	}
	return infos
}

// SaveLayout stores an opaque layout blob for (wsID, breakpoint). Returns false
// for an unknown workspace or an empty breakpoint. An empty layout is allowed
// (acts as a clear).
func (r *Registry) SaveLayout(wsID, breakpoint, layout string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok || breakpoint == "" {
		return false
	}
	if ws.Layouts == nil {
		ws.Layouts = make(map[string]string)
	}
	ws.Layouts[breakpoint] = layout
	return true
}

// Layout returns the stored layout blob for (wsID, breakpoint), or "" if none.
func (r *Registry) Layout(wsID, breakpoint string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok || ws.Layouts == nil {
		return ""
	}
	return ws.Layouts[breakpoint]
}

// RenamePane sets the title of a pane. Returns false for an unknown workspace
// or pane.
func (r *Registry) RenamePane(wsID string, paneID int, name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return false
	}
	p, ok := ws.Panes[paneID]
	if !ok {
		return false
	}
	p.SetTitle(name)
	return true
}

// RemovePane deletes paneID from wsID and returns the removed pane, the number
// of panes remaining in the workspace, and whether the removal happened.
func (r *Registry) RemovePane(wsID string, paneID int) (*Pane, int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.removePaneLocked(wsID, paneID)
}

func (r *Registry) removePaneLocked(wsID string, paneID int) (*Pane, int, bool) {
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil, 0, false
	}
	p, ok := ws.Panes[paneID]
	if !ok {
		return nil, len(ws.Panes), false
	}
	delete(ws.Panes, paneID)
	ws.membershipGeneration++
	return p, len(ws.Panes), true
}
