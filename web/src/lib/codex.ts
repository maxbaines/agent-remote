export type CodexLifecycleState = 'starting' | 'ready' | 'unavailable' | 'stopped';

export interface CodexQuestion {
  header: string;
  question: string;
  options?: string[];
}

export interface CodexPlanStep {
  step: string;
  status: string;
}

export interface CodexSession {
  threadId: string;
  workspaceId?: string;
  name?: string;
  preview?: string;
  cwd?: string;
  status: string;
  activeFlags?: string[];
  updatedAt: number;
  contextUsedPercent?: number;
  contextRemainingPercent?: number;
  questions?: CodexQuestion[];
  approval?: string;
  plan?: CodexPlanStep[];
  currentStep?: string;
}

export interface CodexSnapshot {
  state: CodexLifecycleState;
  error?: string;
  launchArgv?: string[];
  sessions: CodexSession[];
  generatedAt: number;
}

export const DEFAULT_CODEX_SNAPSHOT: CodexSnapshot = {
  state: 'starting',
  sessions: [],
  generatedAt: 0,
};

export function isCodexCommand(command?: string): boolean {
  return /(^|[/\\\s])codex(?:\s|$)/i.test(command ?? '');
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function parseQuestion(value: unknown): CodexQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.question !== 'string') return null;
  return {
    header: typeof raw.header === 'string' ? raw.header : '',
    question: raw.question,
    options: stringArray(raw.options),
  };
}

function parseSession(value: unknown): CodexSession | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.threadId !== 'string' || typeof raw.status !== 'string') return null;
  const questions = Array.isArray(raw.questions)
    ? raw.questions.map(parseQuestion).filter((item): item is CodexQuestion => item !== null)
    : undefined;
  return {
    threadId: raw.threadId,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    preview: typeof raw.preview === 'string' ? raw.preview : undefined,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    status: raw.status,
    activeFlags: stringArray(raw.activeFlags),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    contextUsedPercent: typeof raw.contextUsedPercent === 'number' ? raw.contextUsedPercent : undefined,
    contextRemainingPercent: typeof raw.contextRemainingPercent === 'number'
      ? raw.contextRemainingPercent
      : undefined,
    questions,
    approval: typeof raw.approval === 'string' ? raw.approval : undefined,
    currentStep: typeof raw.currentStep === 'string' ? raw.currentStep : undefined,
  };
}

export function parseCodexSnapshot(value: unknown): CodexSnapshot {
  if (!value || typeof value !== 'object') return DEFAULT_CODEX_SNAPSHOT;
  const raw = value as Record<string, unknown>;
  const state = raw.state === 'ready' || raw.state === 'unavailable' || raw.state === 'stopped'
    ? raw.state
    : 'starting';
  return {
    state,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    launchArgv: stringArray(raw.launchArgv),
    sessions: Array.isArray(raw.sessions)
      ? raw.sessions.map(parseSession).filter((item): item is CodexSession => item !== null)
      : [],
    generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : 0,
  };
}

export async function claimCodexWorkspace(workspaceId: string): Promise<void> {
  const response = await fetch('/api/codex/claims', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) {
    throw new Error((await response.text()).trim() || 'Codex integration is unavailable');
  }
}

export async function acknowledgeCodexDefault(workspaceId: string): Promise<void> {
  const response = await fetch('/api/codex/acknowledge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) throw new Error((await response.text()).trim() || 'Could not acknowledge Codex');
}
