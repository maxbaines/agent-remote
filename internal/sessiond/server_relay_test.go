package sessiond

import (
	"testing"
)

// TestBrowserCommandBroadcast proves that when an attached conn sends a
// browser-command request, every subscriber to that workspace receives a
// TypeBrowserCommand event with its correlation ID and action fields preserved.
func TestBrowserCommandBroadcast(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	// Actor: the client that sends the browser-action request.
	actor := newTClient(t, socketPath)
	actor.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	actor.waitCtrl(TypeComposition)

	// Observer: a second client attached to the same workspace.
	observer := newTClient(t, socketPath)
	observer.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	observer.waitCtrl(TypeComposition)

	// Actor sends a browser-command with CID=99 (a request correlation id).
	actor.send(&Message{
		Type:        TypeBrowserCommand,
		CID:         99,
		WorkspaceID: wsID,
		PaneID:      3,
		Action:      "click",
		Ref:         "e5",
	})

	// Observer should receive a TypeBrowserCommand broadcast with CID preserved.
	msg := observer.waitCtrl(TypeBrowserCommand)
	if msg.CID != 99 {
		t.Fatalf("broadcast CID = %d, want 99", msg.CID)
	}
	if msg.Action != "click" {
		t.Fatalf("broadcast Action = %q, want %q", msg.Action, "click")
	}
	if msg.Ref != "e5" {
		t.Fatalf("broadcast Ref = %q, want %q", msg.Ref, "e5")
	}
	if msg.PaneID != 3 {
		t.Fatalf("broadcast PaneID = %d, want 3", msg.PaneID)
	}
}

// TestBrowserResultBroadcast proves that when an attached conn sends a
// browser-result, every subscriber to that workspace receives a
// TypeBrowserResult event with its correlation ID preserved.
func TestBrowserResultBroadcast(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	// conn A: the browser client that sends the result (shim → Go side).
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// conn B: the MCP client that should receive the broadcast.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	b.waitCtrl(TypeComposition)

	// conn A sends a browser-result with CID=77.
	a.send(&Message{
		Type:  TypeBrowserResult,
		CID:   77,
		Error: "bridge-not-ready",
	})

	// conn B should receive a TypeBrowserResult broadcast with CID preserved.
	msg := b.waitCtrl(TypeBrowserResult)
	if msg.CID != 77 {
		t.Fatalf("broadcast CID = %d, want 77", msg.CID)
	}
}

// TestLayoutCommandBroadcast proves that when an attached conn sends a
// layout-command request, every subscriber to that workspace receives a
// TypeLayoutCommand event with CID == 0 and the action field preserved.
func TestLayoutCommandBroadcast(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	// Actor: the client that sends the layout-command request.
	actor := newTClient(t, socketPath)
	actor.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	actor.waitCtrl(TypeComposition)

	// Observer: a second client attached to the same workspace.
	observer := newTClient(t, socketPath)
	observer.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	observer.waitCtrl(TypeComposition)

	// Actor sends a layout-command with CID=42 (a request correlation id).
	actor.send(&Message{
		Type:        TypeLayoutCommand,
		CID:         42,
		WorkspaceID: wsID,
		Action:      "create-pane",
		PaneID:      0,
	})

	// Observer should receive a TypeLayoutCommand broadcast with CID cleared to 0.
	msg := observer.waitCtrl(TypeLayoutCommand)
	if msg.CID != 0 {
		t.Fatalf("broadcast CID = %d, want 0 (CID must be cleared on broadcast)", msg.CID)
	}
	if msg.Action != "create-pane" {
		t.Fatalf("broadcast Action = %q, want %q", msg.Action, "create-pane")
	}
}
