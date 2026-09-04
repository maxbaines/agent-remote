export type UpdateMethod = 'binary' | 'container' | 'unsupported';

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  devBuild: boolean;
  method: UpdateMethod;
  reason?: string;
  error?: string;
}

const DEFAULT_UPDATE_STATUS: UpdateStatus = {
  currentVersion: '',
  latestVersion: '',
  updateAvailable: false,
  canUpdate: false,
  devBuild: false,
  method: 'unsupported',
};

function parseUpdateStatus(raw: unknown): UpdateStatus {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_UPDATE_STATUS;
  }
  const value = raw as Record<string, unknown>;
  const method = value['method'];
  return {
    currentVersion: typeof value['currentVersion'] === 'string' ? value['currentVersion'] : '',
    latestVersion: typeof value['latestVersion'] === 'string' ? value['latestVersion'] : '',
    updateAvailable: value['updateAvailable'] === true,
    canUpdate: value['canUpdate'] === true,
    devBuild: value['devBuild'] === true,
    method: method === 'binary' || method === 'container'
      ? method
      : 'unsupported',
    reason: typeof value['reason'] === 'string' ? value['reason'] : '',
    error: typeof value['error'] === 'string' ? value['error'] : '',
  };
}

export class UpdateEndpointMissingError extends Error {
  constructor() {
    super('update endpoint not present on the restarted server');
    this.name = 'UpdateEndpointMissingError';
  }
}

export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  const response = await fetch('/api/update/status');
  if (response.status === 404) throw new UpdateEndpointMissingError();
  if (!response.ok) throw new Error(`fetchUpdateStatus: HTTP ${response.status}`);
  return parseUpdateStatus(await response.json());
}

export async function applyUpdate(): Promise<{ version: string }> {
  const response = await fetch('/api/update/apply', { method: 'POST' });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof body['error'] === 'string' && body['error'] !== ''
      ? body['error']
      : `applyUpdate: HTTP ${response.status}`;
    throw new Error(error);
  }
  return { version: typeof body['version'] === 'string' ? body['version'] : '' };
}
