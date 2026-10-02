// CLI/installation contracts. JSON readers describe observed shapes; the
// existing validation functions retain authority over untrusted inputs.
export type RuntimeError = Error & {
  code?: string | number;
  status?: number;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  signal?: string | null;
};
export type Environment = Record<string, string | undefined>;
export interface Provider extends Record<string, unknown> {
  id: string;
  enabled: boolean | null;
  status?: unknown;
  extends?: unknown;
  provenance?: string;
}
export interface Profile extends Record<string, unknown> {
  id: string;
  provider: string;
  name?: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown> | null;
}
export interface Binding {
  provider: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  features?: Record<string, unknown> | null;
  profileId?: string;
  profileProvider?: string;
  optionId?: string;
  catalogSha256?: string;
  catalogFile?: string;
  warnings?: string[];
}
export interface Route extends Record<string, unknown> {
  provider?: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  features?: Record<string, unknown> | null;
  profileId?: string;
  disposition?: string;
  optionId?: string;
  catalogSha256?: string;
  catalogFile?: string;
  quotaFallbackFrom?: string;
  decision?: unknown;
}
export interface HostConfig extends Record<string, unknown> {
  version?: number;
  agents?: {
    providers?: Record<string, unknown>;
    [key: string]: unknown;
  };
  daemon?: {
    agentProfiles?: unknown[];
    mcp?: Record<string, unknown>;
    [key: string]: unknown;
  };
}
export interface CandidateIdentity {
  sha256: string;
  files: {
    path: string;
    sha256: string;
  }[];
}
export interface InstalledManifest {
  source: string;
  candidate: CandidateIdentity;
  paseoBindingSha256?: string;
}
export type SnapshotEntry = {
  path: string;
  kind: 'file' | 'symlink';
  mode: number;
  sha256: string;
} | {
  path: string;
  deleted: true;
  kind?: never;
} | {
  path: string;
  kind: 'gitlink';
  indexOid: string | null;
  headOid: string | null;
  state: 'missing' | 'uninitialized' | 'clean' | 'dirty' | 'conflicted';
};
export interface NestedSnapshot {
  path: string;
  head: string | null;
  sha256: string;
  files: SnapshotEntry[];
  nested?: NestedSnapshot[];
  incomplete?: string[];
}
export interface Snapshot {
  root: string;
  head: string | null;
  sha256: string;
  files: SnapshotEntry[];
  nested?: NestedSnapshot[];
  incomplete?: string[];
}
export interface DaemonAgent extends Record<string, unknown> {
  id: string;
}
export interface LaunchRequest {
  role?: string;
  disposition?: string;
  repository: string;
  assignment: string;
  assignmentFile?: string;
  assignmentFileMode?: 'pointer' | 'snapshot';
  binding?: Binding;
  route?: Route;
  providers?: Provider[];
  profiles?: Profile[];
  inventoryFile?: string;
  paseoHome?: string;
  workspaceId?: string;
  title?: string;
  labels?: Record<string, string>;
  profileId?: string;
  optionId?: string;
  taskLabel?: string;
  handoff?: Handoff;
  [key: string]: unknown;
}

export interface Handoff extends Record<string, unknown> {
  previousAgentId: string;
  reason: string;
  authority: string;
  state: string;
  previousOwner: {
    settled: boolean;
    evidence: string;
  };
  resources: unknown[];
}

// Projected only at optional-chain call sites; the state reader guarantees only id.
export interface PersistenceObservation {
  provider?: unknown;
  nativeHandle?: unknown;
  metadata?: {
    cwd?: unknown;
  };
}
