const CLEAR_BOUNDARY_STORAGE_PREFIX = 'just-terminal.clear-to-start.v1:';
const MAX_RETAINED_BYTES = 1 << 20;

interface ClearBoundaryRecord {
  chunks: string[];
  byteLength: number;
}

const encoder = new TextEncoder();

function bytesOf(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

function encodeBase64(data: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < data.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return data;
}

/**
 * Owns one Remote Client's retained Clear-to-start boundaries. sessionStorage
 * deliberately scopes the boundary to this browser tab while surviving its
 * reloads; neither the Gateway nor the Session Owner observes this state.
 */
export class TerminalPresentationController {
  readonly #memory = new Map<string, ClearBoundaryRecord>();

  startClearBoundary(paneKey: string): void {
    const record: ClearBoundaryRecord = { chunks: [], byteLength: 0 };
    this.#memory.set(paneKey, record);
    this.#persist(paneKey, record);
  }

  appendAfterBoundary(paneKey: string, data: Uint8Array | string): void {
    const record = this.#read(paneKey);
    if (!record) return;
    const bytes = bytesOf(data);
    if (record.byteLength + bytes.byteLength > MAX_RETAINED_BYTES) return;
    record.chunks.push(encodeBase64(bytes));
    record.byteLength += bytes.byteLength;
    this.#memory.set(paneKey, record);
    this.#persist(paneKey, record);
  }

  replayAfterBoundary(paneKey: string): Uint8Array[] | null {
    const record = this.#read(paneKey);
    return record ? record.chunks.map(decodeBase64) : null;
  }

  forget(paneKey: string): void {
    this.#memory.delete(paneKey);
    try {
      sessionStorage.removeItem(`${CLEAR_BOUNDARY_STORAGE_PREFIX}${paneKey}`);
    } catch {
      // Storage may be unavailable; the in-memory boundary is already gone.
    }
  }

  #read(paneKey: string): ClearBoundaryRecord | null {
    const remembered = this.#memory.get(paneKey);
    if (remembered) return remembered;
    try {
      const raw = sessionStorage.getItem(`${CLEAR_BOUNDARY_STORAGE_PREFIX}${paneKey}`);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as Partial<ClearBoundaryRecord>;
      if (
        !Array.isArray(parsed.chunks) ||
        !parsed.chunks.every((chunk) => typeof chunk === 'string') ||
        typeof parsed.byteLength !== 'number' ||
        !Number.isFinite(parsed.byteLength) ||
        parsed.byteLength < 0
      ) return null;
      const record = { chunks: parsed.chunks, byteLength: parsed.byteLength };
      this.#memory.set(paneKey, record);
      return record;
    } catch {
      return null;
    }
  }

  #persist(paneKey: string, record: ClearBoundaryRecord): void {
    try {
      sessionStorage.setItem(`${CLEAR_BOUNDARY_STORAGE_PREFIX}${paneKey}`, JSON.stringify(record));
    } catch {
      // Keep the live in-memory boundary even if storage is unavailable/full.
    }
  }
}

export const terminalPresentation = new TerminalPresentationController();
