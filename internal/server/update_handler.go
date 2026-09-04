package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/maxbaines/just-terminal/internal/update"
)

const sessiondUpdateReason = "The running Session Owner was preserved because this version cannot restore live terminal processes after a restart."

func writeUpdateJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func writeUpdateError(w http.ResponseWriter, code int, reason string) {
	writeUpdateJSON(w, code, map[string]any{"error": reason})
}

func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	status, _ := update.Check(r.Context(), s.version)
	writeUpdateJSON(w, http.StatusOK, status)
}

func (s *Server) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	if !s.updating.CompareAndSwap(false, true) {
		writeUpdateError(w, http.StatusConflict, "an update is already in progress")
		return
	}
	applied := false
	defer func() {
		if !applied {
			s.updating.Store(false)
		}
	}()

	status, release := update.Check(r.Context(), s.version)
	if !status.CanUpdate {
		reason := status.Reason
		if reason == "" {
			reason = status.Error
		}
		if reason == "" {
			reason = "already up to date"
		}
		writeUpdateError(w, http.StatusConflict, reason)
		return
	}
	if release == nil {
		log.Printf("update_handler: CanUpdate with no resolved release")
		writeUpdateError(w, http.StatusInternalServerError, "could not resolve the latest release")
		return
	}
	if err := update.Apply(r.Context(), release); err != nil {
		log.Printf("update_handler: apply %s: %v", release.Tag, err)
		writeUpdateError(w, http.StatusInternalServerError, err.Error())
		return
	}
	applied = true

	writeUpdateJSON(w, http.StatusOK, map[string]any{
		"status":          "ok",
		"version":         strings.TrimPrefix(release.Tag, "v"),
		"sessiondRestart": false,
		"sessiondReason":  sessiondUpdateReason,
	})
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	go func() {
		time.Sleep(500 * time.Millisecond)
		if err := update.Restart(); err != nil {
			log.Printf("update_handler: restart after update: %v", err)
		}
	}()
}
