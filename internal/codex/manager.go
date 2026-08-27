package codex

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const (
	stateStarting    = "starting"
	stateReady       = "ready"
	stateUnavailable = "unavailable"
	stateStopped     = "stopped"
)

// Question is the user-visible portion of a Codex request_user_input request.
// Secret answers are never present here; app-server only sends the prompt
// shape and the browser continues to answer inside Codex's terminal UI.
type Question struct {
	Header   string   `json:"header"`
	Question string   `json:"question"`
	Options  []string `json:"options,omitempty"`
}

// PlanStep is a compact projection of Codex's live turn plan.
type PlanStep struct {
	Step   string `json:"step"`
	Status string `json:"status"`
}

// Session is the browser-facing projection of one Codex thread. App-server's
// versioned JSON-RPC vocabulary remains private to this module.
type Session struct {
	ThreadID                string     `json:"threadId"`
	WorkspaceID             string     `json:"workspaceId,omitempty"`
	Name                    string     `json:"name,omitempty"`
	Preview                 string     `json:"preview,omitempty"`
	CWD                     string     `json:"cwd,omitempty"`
	Status                  string     `json:"status"`
	ActiveFlags             []string   `json:"activeFlags,omitempty"`
	UpdatedAt               int64      `json:"updatedAt"`
	ContextUsedPercent      *int       `json:"contextUsedPercent,omitempty"`
	ContextRemainingPercent *int       `json:"contextRemainingPercent,omitempty"`
	Questions               []Question `json:"questions,omitempty"`
	Approval                string     `json:"approval,omitempty"`
	Plan                    []PlanStep `json:"plan,omitempty"`
	CurrentStep             string     `json:"currentStep,omitempty"`
	requestIDs              map[string]pendingRequest
}

type pendingRequest struct {
	kind string
}

// Snapshot is the complete state consumed by the frontend. LaunchArgv is
// supplied only while the managed app-server is ready.
type Snapshot struct {
	State       string    `json:"state"`
	Error       string    `json:"error,omitempty"`
	LaunchArgv  []string  `json:"launchArgv,omitempty"`
	Sessions    []Session `json:"sessions"`
	GeneratedAt int64     `json:"generatedAt"`
}

type claim struct {
	WorkspaceID string `json:"workspaceId"`
	CreatedAt   int64  `json:"createdAt"`
}

type persistedState struct {
	Assignments map[string]string `json:"assignments"`
}

// Manager owns one Codex app-server child, reconnects its observer, projects
// JSON-RPC events into Snapshot, and associates integrated terminal launches
// with JustTerminal workspaces. Callers only need Run, Snapshot, and Claim.
type Manager struct {
	runtimeDir string
	socketPath string
	logPath    string
	statePath  string
	onUpdate   func(Snapshot)

	mu          sync.RWMutex
	snapshot    Snapshot
	sessions    map[string]*Session
	assignments map[string]string // workspace id -> thread id
	claims      []claim
	seenThreads map[string]bool
	subscribed  map[string]bool
}

func NewManager(runtimeDir string, onUpdate func(Snapshot)) *Manager {
	m := &Manager{
		runtimeDir:  runtimeDir,
		socketPath:  managedSocketPath(runtimeDir),
		logPath:     filepath.Join(runtimeDir, "codex-app-server.log"),
		statePath:   filepath.Join(runtimeDir, "codex-workspaces.json"),
		onUpdate:    onUpdate,
		sessions:    make(map[string]*Session),
		assignments: make(map[string]string),
		seenThreads: make(map[string]bool),
		subscribed:  make(map[string]bool),
		snapshot: Snapshot{
			State:       stateStarting,
			Sessions:    []Session{},
			GeneratedAt: time.Now().UnixMilli(),
		},
	}
	m.loadState()
	return m
}

// managedSocketPath preserves the private XDG runtime location when it fits,
// then falls back to a deterministic uid+runtime hash under /tmp on platforms
// with short sockaddr_un limits (notably macOS SUN_LEN=104). The hash keeps
// isolated dev instances and worktrees from colliding.
func managedSocketPath(runtimeDir string) string {
	candidate := filepath.Join(runtimeDir, "codex.sock")
	if len(candidate) < 90 {
		return candidate
	}
	sum := sha256.Sum256([]byte(runtimeDir))
	shortRoot := "/tmp"
	if runtime.GOOS == "darwin" {
		// /tmp is a symlink on macOS. Codex app-server intentionally rejects a
		// symlinked socket directory, so use its canonical real directory.
		shortRoot = "/private/tmp"
	}
	shortDir := filepath.Join(shortRoot, fmt.Sprintf("ar-codex-%d-%x", os.Getuid(), sum[:4]))
	return filepath.Join(shortDir, "app.sock")
}

// Snapshot returns an immutable copy suitable for an HTTP or WebSocket frame.
func (m *Manager) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return cloneSnapshot(m.snapshot)
}

// Claim records that the next newly-created CLI thread belongs to workspaceID.
// The browser calls this immediately before creating the driver pane.
func (m *Manager) Claim(workspaceID string) error {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return fmt.Errorf("workspaceId is required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.snapshot.State != stateReady {
		return fmt.Errorf("Codex integration is not ready")
	}
	for _, pending := range m.claims {
		if pending.WorkspaceID == workspaceID {
			return nil
		}
	}
	m.claims = append(m.claims, claim{WorkspaceID: workspaceID, CreatedAt: time.Now().Unix()})
	return nil
}

// Run supervises app-server until ctx is cancelled. Missing Codex is a soft
// failure: the manager keeps retrying and normal terminal work remains usable.
func (m *Manager) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := m.runOnce(ctx)
		if ctx.Err() != nil {
			break
		}
		m.setLifecycle(stateUnavailable, errString(err), nil)
		select {
		case <-ctx.Done():
			break
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
	m.setLifecycle(stateStopped, "", nil)
}

func (m *Manager) runOnce(ctx context.Context) error {
	codexPath, err := findCodex()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(m.runtimeDir, 0o700); err != nil {
		return fmt.Errorf("create Codex runtime directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(m.socketPath), 0o700); err != nil {
		return fmt.Errorf("create Codex socket directory: %w", err)
	}
	if err := os.Chmod(filepath.Dir(m.socketPath), 0o700); err != nil {
		return fmt.Errorf("secure Codex socket directory: %w", err)
	}
	if err := os.Remove(m.socketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale Codex socket: %w", err)
	}
	logFile, err := os.OpenFile(m.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open Codex log: %w", err)
	}
	defer logFile.Close()

	childCtx, cancelChild := context.WithCancel(ctx)
	defer cancelChild()
	cmd := exec.CommandContext(childCtx, codexPath, "app-server", "--listen", "unix://"+m.socketPath)
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	}
	cmd.WaitDelay = 4 * time.Second
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Codex app-server: %w", err)
	}
	childDone := make(chan error, 1)
	go func() { childDone <- cmd.Wait() }()
	defer func() {
		cancelChild()
		if cmd.ProcessState == nil {
			select {
			case <-childDone:
			case <-time.After(5 * time.Second):
				if cmd.Process != nil {
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				}
				<-childDone
			}
		}
		_ = os.Remove(m.socketPath)
	}()

	if err := waitForSocket(ctx, childDone, m.socketPath); err != nil {
		return err
	}
	rpc, err := dialRPC(ctx, m.socketPath, m.handleMessage)
	if err != nil {
		return fmt.Errorf("connect Codex app-server: %w", err)
	}
	defer rpc.Close()

	initCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := rpc.Call(initCtx, "initialize", map[string]any{
		"clientInfo": map[string]string{
			"name":    "just_terminal",
			"title":   "JustTerminal",
			"version": "1",
		},
		"capabilities": map[string]any{"experimentalApi": true},
	}); err != nil {
		return fmt.Errorf("initialize Codex app-server: %w", err)
	}
	if err := rpc.Notify(ctx, "initialized", map[string]any{}); err != nil {
		return fmt.Errorf("acknowledge Codex app-server initialization: %w", err)
	}
	m.setLifecycle(stateReady, "", []string{codexPath, "--remote", "unix://" + m.socketPath})
	if err := m.syncThreads(ctx, rpc); err != nil {
		return err
	}

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-childDone:
			return fmt.Errorf("Codex app-server exited: %w", err)
		case err := <-rpc.Done():
			return fmt.Errorf("Codex observer disconnected: %w", err)
		case <-ticker.C:
			if err := m.syncThreads(ctx, rpc); err != nil {
				return err
			}
		}
	}
}

func findCodex() (string, error) {
	if path, err := exec.LookPath("codex"); err == nil {
		return path, nil
	}
	for _, path := range []string{
		"/usr/local/bin/codex",
		"/opt/homebrew/bin/codex",
		filepath.Join(os.Getenv("HOME"), ".local", "bin", "codex"),
	} {
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return path, nil
		}
	}
	return "", fmt.Errorf("Codex CLI is not installed or not on PATH")
}

func waitForSocket(ctx context.Context, childDone <-chan error, path string) error {
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-childDone:
			return fmt.Errorf("Codex app-server exited before becoming ready: %w", err)
		case <-deadline.C:
			return fmt.Errorf("Codex app-server did not create %s within timeout", path)
		case <-ticker.C:
			conn, err := net.DialTimeout("unix", path, 100*time.Millisecond)
			if err == nil {
				_ = conn.Close()
				return nil
			}
		}
	}
}

type rpcThread struct {
	ID        string          `json:"id"`
	Preview   string          `json:"preview"`
	Name      *string         `json:"name"`
	CWD       string          `json:"cwd"`
	CreatedAt int64           `json:"createdAt"`
	UpdatedAt int64           `json:"updatedAt"`
	Status    rpcThreadStatus `json:"status"`
}

type rpcThreadStatus struct {
	Type        string   `json:"type"`
	ActiveFlags []string `json:"activeFlags"`
}

func (m *Manager) syncThreads(ctx context.Context, rpc *rpcClient) error {
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, err := rpc.Call(callCtx, "thread/list", map[string]any{
		"limit":         100,
		"sortKey":       "recency_at",
		"sortDirection": "desc",
		"sourceKinds":   []string{"cli"},
	})
	if err != nil {
		return fmt.Errorf("list Codex threads: %w", err)
	}
	var response struct {
		Data []rpcThread `json:"data"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return fmt.Errorf("decode Codex thread list: %w", err)
	}

	var subscribe, unsubscribe []string
	m.mu.Lock()
	for _, thread := range response.Data {
		session := m.sessions[thread.ID]
		if session == nil {
			session = &Session{ThreadID: thread.ID, requestIDs: make(map[string]pendingRequest)}
			m.sessions[thread.ID] = session
		}
		session.Preview = thread.Preview
		if thread.Name != nil {
			session.Name = *thread.Name
		}
		session.CWD = thread.CWD
		session.Status = thread.Status.Type
		session.ActiveFlags = append([]string(nil), thread.Status.ActiveFlags...)
		session.UpdatedAt = thread.UpdatedAt
		m.assignClaimLocked(thread)
		m.seenThreads[thread.ID] = true
		// Keep every JustTerminal-owned thread subscribed even while idle. The
		// app-server emits token usage, plans, questions, and approvals only to
		// subscribed clients; waiting until the next poll observes "active" can
		// miss an entire short turn. Unmanaged threads remain active-only so we
		// do not resume the user's full Codex history.
		shouldSubscribe := thread.Status.Type == "active" || session.WorkspaceID != ""
		if shouldSubscribe && !m.subscribed[thread.ID] {
			m.subscribed[thread.ID] = true
			subscribe = append(subscribe, thread.ID)
		} else if !shouldSubscribe && m.subscribed[thread.ID] {
			delete(m.subscribed, thread.ID)
			unsubscribe = append(unsubscribe, thread.ID)
		}
	}
	m.rebuildSnapshotLocked()
	m.mu.Unlock()
	m.publish()

	for _, threadID := range subscribe {
		if _, err := rpc.Call(callCtx, "thread/resume", map[string]any{"threadId": threadID}); err != nil {
			log.Printf("just-terminal: subscribe to Codex thread %s: %v", threadID, err)
		}
	}
	for _, threadID := range unsubscribe {
		if _, err := rpc.Call(callCtx, "thread/unsubscribe", map[string]any{"threadId": threadID}); err != nil {
			log.Printf("just-terminal: unsubscribe from Codex thread %s: %v", threadID, err)
		}
	}
	return nil
}

func (m *Manager) assignClaimLocked(thread rpcThread) {
	for workspaceID, threadID := range m.assignments {
		if threadID == thread.ID {
			if session := m.sessions[thread.ID]; session != nil {
				session.WorkspaceID = workspaceID
			}
			return
		}
	}
	if m.seenThreads[thread.ID] || len(m.claims) == 0 {
		return
	}
	for i, pending := range m.claims {
		if thread.CreatedAt < pending.CreatedAt-5 {
			continue
		}
		m.assignments[pending.WorkspaceID] = thread.ID
		if session := m.sessions[thread.ID]; session != nil {
			session.WorkspaceID = pending.WorkspaceID
		}
		m.claims = append(m.claims[:i], m.claims[i+1:]...)
		m.saveStateLocked()
		return
	}
}

func (m *Manager) handleMessage(msg rpcEnvelope) {
	if msg.Method == "" {
		return
	}
	changed := false
	m.mu.Lock()
	switch msg.Method {
	case "thread/started":
		var params struct {
			Thread rpcThread `json:"thread"`
		}
		if json.Unmarshal(msg.Params, &params) == nil && params.Thread.ID != "" {
			thread := params.Thread
			session := m.sessions[thread.ID]
			if session == nil {
				session = &Session{ThreadID: thread.ID, requestIDs: make(map[string]pendingRequest)}
				m.sessions[thread.ID] = session
			}
			session.Preview = thread.Preview
			session.CWD = thread.CWD
			session.Status = thread.Status.Type
			session.ActiveFlags = append([]string(nil), thread.Status.ActiveFlags...)
			session.UpdatedAt = thread.UpdatedAt
			m.assignClaimLocked(thread)
			m.seenThreads[thread.ID] = true
			changed = true
		}
	case "thread/status/changed":
		var params struct {
			ThreadID string          `json:"threadId"`
			Status   rpcThreadStatus `json:"status"`
		}
		if json.Unmarshal(msg.Params, &params) == nil {
			if session := m.sessions[params.ThreadID]; session != nil {
				session.Status = params.Status.Type
				session.ActiveFlags = append([]string(nil), params.Status.ActiveFlags...)
				changed = true
			}
		}
	case "thread/tokenUsage/updated":
		var params struct {
			ThreadID   string `json:"threadId"`
			TokenUsage struct {
				Total struct {
					TotalTokens int `json:"totalTokens"`
				} `json:"total"`
				ModelContextWindow *int `json:"modelContextWindow"`
			} `json:"tokenUsage"`
		}
		if json.Unmarshal(msg.Params, &params) == nil && params.TokenUsage.ModelContextWindow != nil && *params.TokenUsage.ModelContextWindow > 0 {
			if session := m.sessions[params.ThreadID]; session != nil {
				used := params.TokenUsage.Total.TotalTokens * 100 / *params.TokenUsage.ModelContextWindow
				if used > 100 {
					used = 100
				}
				remaining := 100 - used
				session.ContextUsedPercent = &used
				session.ContextRemainingPercent = &remaining
				changed = true
			}
		}
	case "turn/plan/updated":
		var params struct {
			ThreadID string     `json:"threadId"`
			Plan     []PlanStep `json:"plan"`
		}
		if json.Unmarshal(msg.Params, &params) == nil {
			if session := m.sessions[params.ThreadID]; session != nil {
				session.Plan = append([]PlanStep(nil), params.Plan...)
				session.CurrentStep = ""
				for _, step := range params.Plan {
					if step.Status == "inProgress" || step.Status == "in_progress" {
						session.CurrentStep = step.Step
						break
					}
				}
				changed = true
			}
		}
	case "item/tool/requestUserInput":
		changed = m.captureQuestionLocked(msg)
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval":
		changed = m.captureApprovalLocked(msg)
	case "serverRequest/resolved":
		var params struct {
			ThreadID  string          `json:"threadId"`
			RequestID json.RawMessage `json:"requestId"`
		}
		if json.Unmarshal(msg.Params, &params) == nil {
			if session := m.sessions[params.ThreadID]; session != nil {
				delete(session.requestIDs, string(params.RequestID))
				m.rebuildPendingLocked(session)
				changed = true
			}
		}
	case "turn/completed":
		var params struct {
			ThreadID string `json:"threadId"`
		}
		if json.Unmarshal(msg.Params, &params) == nil {
			if session := m.sessions[params.ThreadID]; session != nil {
				session.Questions = nil
				session.Approval = ""
				session.requestIDs = make(map[string]pendingRequest)
				session.CurrentStep = ""
				changed = true
			}
		}
	}
	if changed {
		m.rebuildSnapshotLocked()
	}
	m.mu.Unlock()
	if changed {
		m.publish()
	}
}

func (m *Manager) captureQuestionLocked(msg rpcEnvelope) bool {
	var params struct {
		ThreadID  string `json:"threadId"`
		Questions []struct {
			Header   string `json:"header"`
			Question string `json:"question"`
			IsSecret bool   `json:"isSecret"`
			Options  []struct {
				Label string `json:"label"`
			} `json:"options"`
		} `json:"questions"`
	}
	if json.Unmarshal(msg.Params, &params) != nil {
		return false
	}
	session := m.sessions[params.ThreadID]
	if session == nil {
		return false
	}
	questions := make([]Question, 0, len(params.Questions))
	for _, q := range params.Questions {
		question := Question{Header: q.Header, Question: q.Question}
		for _, option := range q.Options {
			question.Options = append(question.Options, option.Label)
		}
		questions = append(questions, question)
	}
	session.Questions = questions
	requestID := string(msg.ID)
	if requestID != "" {
		session.requestIDs[requestID] = pendingRequest{kind: "question"}
	}
	return true
}

func (m *Manager) captureApprovalLocked(msg rpcEnvelope) bool {
	var params struct {
		ThreadID string `json:"threadId"`
		Reason   string `json:"reason"`
		Command  string `json:"command"`
	}
	if json.Unmarshal(msg.Params, &params) != nil {
		return false
	}
	session := m.sessions[params.ThreadID]
	if session == nil {
		return false
	}
	summary := strings.TrimSpace(params.Reason)
	if summary == "" {
		summary = strings.TrimSpace(params.Command)
	}
	if summary == "" {
		summary = "Approval required"
	}
	if len(summary) > 160 {
		summary = summary[:157] + "…"
	}
	session.Approval = summary
	requestID := string(msg.ID)
	if requestID != "" {
		session.requestIDs[requestID] = pendingRequest{kind: "approval"}
	}
	return true
}

func (m *Manager) rebuildPendingLocked(session *Session) {
	hasQuestion, hasApproval := false, false
	for _, request := range session.requestIDs {
		switch request.kind {
		case "question":
			hasQuestion = true
		case "approval":
			hasApproval = true
		}
	}
	if !hasQuestion {
		session.Questions = nil
	}
	if !hasApproval {
		session.Approval = ""
	}
}

func (m *Manager) setLifecycle(state, errText string, argv []string) {
	m.mu.Lock()
	m.snapshot.State = state
	m.snapshot.Error = errText
	m.snapshot.LaunchArgv = append([]string(nil), argv...)
	m.snapshot.GeneratedAt = time.Now().UnixMilli()
	m.mu.Unlock()
	m.publish()
}

func (m *Manager) rebuildSnapshotLocked() {
	sessions := make([]Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		copySession := *session
		copySession.ActiveFlags = append([]string(nil), session.ActiveFlags...)
		copySession.Questions = append([]Question(nil), session.Questions...)
		copySession.Plan = append([]PlanStep(nil), session.Plan...)
		copySession.requestIDs = nil
		sessions = append(sessions, copySession)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].UpdatedAt > sessions[j].UpdatedAt })
	m.snapshot.Sessions = sessions
	m.snapshot.GeneratedAt = time.Now().UnixMilli()
}

func (m *Manager) publish() {
	if m.onUpdate != nil {
		m.onUpdate(m.Snapshot())
	}
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	clone := snapshot
	clone.LaunchArgv = append([]string(nil), snapshot.LaunchArgv...)
	clone.Sessions = make([]Session, len(snapshot.Sessions))
	for i, session := range snapshot.Sessions {
		clone.Sessions[i] = session
		clone.Sessions[i].ActiveFlags = append([]string(nil), session.ActiveFlags...)
		clone.Sessions[i].Questions = append([]Question(nil), session.Questions...)
		clone.Sessions[i].Plan = append([]PlanStep(nil), session.Plan...)
		clone.Sessions[i].requestIDs = nil
	}
	return clone
}

func (m *Manager) loadState() {
	data, err := os.ReadFile(m.statePath)
	if err != nil {
		return
	}
	var state persistedState
	if json.Unmarshal(data, &state) == nil && state.Assignments != nil {
		m.assignments = state.Assignments
	}
}

func (m *Manager) saveStateLocked() {
	data, err := json.Marshal(persistedState{Assignments: m.assignments})
	if err != nil {
		return
	}
	if err := os.WriteFile(m.statePath, data, 0o600); err != nil {
		log.Printf("just-terminal: persist Codex workspace assignments: %v", err)
	}
}

func errString(err error) string {
	if err == nil || errors.Is(err, context.Canceled) {
		return ""
	}
	return err.Error()
}

type rpcEnvelope struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type rpcClient struct {
	conn      *websocket.Conn
	nextID    atomic.Int64
	writeMu   sync.Mutex
	pendingMu sync.Mutex
	pending   map[int64]chan rpcEnvelope
	done      chan error
	onMessage func(rpcEnvelope)
}

func dialRPC(ctx context.Context, socketPath string, onMessage func(rpcEnvelope)) (*rpcClient, error) {
	transport := &http.Transport{
		DialContext: func(dialCtx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(dialCtx, "unix", socketPath)
		},
	}
	conn, response, err := websocket.Dial(ctx, "http://localhost/", &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: transport},
	})
	if err != nil {
		if response != nil {
			return nil, fmt.Errorf("websocket handshake status %s: %w", response.Status, err)
		}
		return nil, err
	}
	conn.SetReadLimit(16 << 20)
	client := &rpcClient{
		conn:      conn,
		pending:   make(map[int64]chan rpcEnvelope),
		done:      make(chan error, 1),
		onMessage: onMessage,
	}
	go client.readLoop(ctx)
	return client, nil
}

func (c *rpcClient) Done() <-chan error { return c.done }

func (c *rpcClient) Close() {
	_ = c.conn.Close(websocket.StatusNormalClosure, "JustTerminal shutting down")
}

func (c *rpcClient) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	responseCh := make(chan rpcEnvelope, 1)
	c.pendingMu.Lock()
	c.pending[id] = responseCh
	c.pendingMu.Unlock()
	defer func() {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
	}()
	if err := c.write(ctx, map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case response := <-responseCh:
		if response.Error != nil {
			return nil, fmt.Errorf("%s (%d)", response.Error.Message, response.Error.Code)
		}
		return response.Result, nil
	}
}

func (c *rpcClient) Notify(ctx context.Context, method string, params any) error {
	return c.write(ctx, map[string]any{"method": method, "params": params})
}

func (c *rpcClient) write(ctx context.Context, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.Write(ctx, websocket.MessageText, data)
}

func (c *rpcClient) readLoop(ctx context.Context) {
	for {
		messageType, data, err := c.conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure || errors.Is(err, context.Canceled) {
				err = io.EOF
			}
			c.done <- err
			return
		}
		if messageType != websocket.MessageText {
			continue
		}
		var envelope rpcEnvelope
		if json.Unmarshal(data, &envelope) != nil {
			continue
		}
		if envelope.Method == "" && len(envelope.ID) > 0 {
			var id int64
			if json.Unmarshal(envelope.ID, &id) == nil {
				c.pendingMu.Lock()
				responseCh := c.pending[id]
				c.pendingMu.Unlock()
				if responseCh != nil {
					responseCh <- envelope
				}
			}
			continue
		}
		if c.onMessage != nil {
			c.onMessage(envelope)
		}
	}
}
