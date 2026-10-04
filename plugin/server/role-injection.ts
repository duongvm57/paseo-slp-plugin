// plugin/server/role-injection.ts — the agent.create / agent.session_open
// before-hooks (settings-driven-providers.md §6 Phase 2).
//
// Hook families (codex/pi/claude) reach a managed seat through a sentinel-
// gated thin alias: the provider entry keeps its slp-* identity and native
// `extends`, its command runs the candidate's bin/slp-gate.mjs, and this
// module supplies the two halves the gate cannot supply itself —
//
//   agent.create       → roleBundle() rendered from the materialized
//                        candidate is prepended to config.systemPrompt, so
//                        the native seat starts with the role contract in
//                        its durable instructions (role authority leads: a
//                        pre-existing systemPrompt is appended after it).
//   agent.session_open → a non-empty per-open SLP_SESSION_OPEN_GRANT env
//                        overlay, which is the only thing that lets the gate
//                        forward to the real family binary. During a hook
//                        gap the grant stays the empty sentinel and the
//                        gate fails closed.
//
// slp-devin-* and non-slp providers pass through untouched — devin keeps the
// shim+wrapper transport (the 0.8.0 ACP adapter drops systemPrompt anyway).
//
// The role bundle is dynamically imported from the binding's materialized
// candidate (<stableRoot>/<candidateSha256>/plugin/server/runtime/cli/role-bundle.ts) — never from
// this plugin checkout (the §2 no-cross-boundary rule); imports are cached
// per candidate sha so a hook call costs one receipt read plus a render.
//
// Candidate verification (review finding O1): the devin shim re-verifies the
// launch manifest and candidate on every launch; the hook path gets the same
// parity through a per-create verification — the published candidate tree is
// re-verified against its anchored record before any of its code is imported.
// Verification is cached once per candidate sha per plugin process (the tree
// is immutable, so a verified sha never goes stale), and failures are evicted
// so a repaired candidate verifies on the next create. The same check
// transitively covers bin/slp-gate.mjs: the gate launcher execs it after
// this hook in the same launch flow, so its bytes are verified before they
// run. agent.session_open does not verify — it only mints a grant and never
// loads candidate code.

import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { familyFromProviderId, HOOK_PROVIDER_ID_RE, ROLES, WRAPPER_PROVIDER_ID_RE, type FamilyId } from "../shared/runtime/families.ts";
import { candidateModulePath } from "./candidate-module.ts";
import { DESK_HANDLE_KEY, DESK_TASK_CREATE_TICKET_KEY, type DeskSeatTaskCreateTicketContext } from "./desk-seat.ts";

type AgentCreateRequest = PluginBeforeRequests["agent.create"];
type SessionOpenRequest = PluginBeforeRequests["agent.session_open"];

/** The fields of a live binding the hooks need. index.server.ts resolves
 *  them from the journal receipt at <daemonHome>/slp-runtime/state/. */
export interface ActiveBinding {
  candidateSha256: string;
  /** The candidate's recorded payload identity — verifyPublished's second
   *  anchor alongside candidateSha256. */
  payloadSha256: string;
  /** <stableRoot>/<candidateSha256> — the immutable candidate root. */
  runtimePath: string;
  /** The binding's verified ordinary-Node path (SLP_NODE_BIN). */
  nodePath: string;
  /** The binding's canonical daemon home (SLP_DAEMON_HOME). */
  daemonHome: string;
}

/** Minimal structural type of the candidate's plugin/server/runtime/cli/role-bundle.ts. */
export interface RoleBundleModule {
  roleBundle(
    root: string,
    role: string,
    env: Record<string, string>,
    options?: Record<string, unknown>,
  ): { role: string; instructions: string };
}

export interface RoleInjectionDeps {
  /** Return the live binding, or null when no receipt/binding exists. May
   *  throw on unreadable/corrupt journal state — the hooks propagate it as
   *  fail-closed behavior for managed providers. */
  readActiveBinding(): ActiveBinding | null;
  /** Re-verify the binding's published candidate before any of its code is
   *  loaded — production wires `materializer.verifyPublished(runtimePath,
   *  candidateSha256, payloadSha256)`. Called once per candidate sha per
   *  process (success is cached); a throw aborts the create and is evicted,
   *  so a repaired candidate verifies on the next attempt. Required: there
   *  is no safe default that skips verification. */
  verifyCandidate: (binding: ActiveBinding) => Promise<void> | void;
  /** Dynamic-import seam; production uses import(pathToFileURL(...).href). */
  importModule?: (specifier: string) => Promise<RoleBundleModule>;
  /** Grant-token derivation seam for tests; must return a non-empty token. */
  grantToken?: (request: { agentId: string; reason: string }) => string;
  /** P2-c desk seams — both optional and asynchronous; absent means the
   *  pre-P2-c behavior byte-for-byte for ordinary requests. Ordinary mint
   *  remains fail-open, but a reserved task create ticket is deliberately
   *  fail-closed before native create unless deskMint validates and consumes
   *  its exact claim. deskMint resolves the membership handle AFTER the
   *  seat.mint commit (G1) or null on ordinary failure; deskBind reports the
   *  env-echoed handle and never throws. */
  deskMint?: (input: {
    provider: string;
    family: FamilyId;
    role: string;
    cwd: string | undefined;
    env: Record<string, string>;
    taskCreateTicketContext?: DeskSeatTaskCreateTicketContext;
  }) => Promise<{ handle: string } | null>;
  deskBind?: (input: {
    agentId: string;
    workspaceId: string | null;
    provider: string;
    cwd: string;
    reason: SessionOpenRequest["reason"];
    purpose: SessionOpenRequest["purpose"];
    env: Record<string, string>;
  }) => Promise<void>;
}

// The id classes derive from the family registry (shared/runtime/families.ts): hook
// transport = thin alias + gate launcher; wrapper transport = devin's shim.
const HOOK_FAMILY_PROVIDER = HOOK_PROVIDER_ID_RE;
const DEVIN_PROVIDER = WRAPPER_PROVIDER_ID_RE;
const VALID_ROLES = new Set<string>(ROLES);

/** Resolve the role a provider id carries, or null for pass-through
 *  providers (non-slp and the devin wrapper path). Every other slp-* id must
 *  resolve — through the owned suffix or the `slp_role` feature marker (the
 *  4-provider variant seam) — or the create fails closed: an slp-* provider
 *  we cannot map would otherwise spawn a silently unroled managed seat. */
function roleForCreate(provider: string, featureValues: Record<string, unknown> | undefined): string | null {
  const owned = HOOK_FAMILY_PROVIDER.exec(provider);
  if (owned !== null) return owned[2];
  if (!provider.startsWith("slp-") || DEVIN_PROVIDER.test(provider)) return null;
  const marker = featureValues?.["slp_role"];
  if (typeof marker === "string" && VALID_ROLES.has(marker)) return marker;
  throw new Error(
    `SLP role injection cannot resolve a role for provider ${provider}: ` +
      "not an owned slp-<hook-family>-<role> id and no valid featureValues.slp_role marker",
  );
}

function defaultGrantToken(request: { agentId: string; reason: string }): string {
  return createHash("sha256")
    .update(`slp-session-open:${request.agentId}:${request.reason}:${randomUUID()}`)
    .digest("hex");
}

export function createRoleInjection(deps: RoleInjectionDeps) {
  const importModule = deps.importModule ?? ((specifier: string) => import(specifier) as Promise<RoleBundleModule>);
  const grantToken = deps.grantToken ?? defaultGrantToken;
  // Imported role-bundle modules keyed by candidate sha: the candidate is
  // immutable, so a resolved module never goes stale. Failures are evicted
  // so a transient filesystem error can retry on the next create instead of
  // pinning the candidate to its first failure.
  const moduleCache = new Map<string, Promise<RoleBundleModule>>();
  // Successful candidate verifications keyed by candidate sha — the tree is
  // immutable, so one verified sha never goes stale. Failures evict, like
  // moduleCache, so a repaired candidate re-verifies on the next create
  // rather than pinning the sha to its first failure.
  const verifyCache = new Map<string, Promise<void>>();

  function verifyCandidateOnce(binding: ActiveBinding): Promise<void> {
    const cached = verifyCache.get(binding.candidateSha256);
    if (cached !== undefined) return cached;
    const promise = Promise.resolve().then(() => deps.verifyCandidate(binding));
    promise.catch(() => {
      if (verifyCache.get(binding.candidateSha256) === promise) {
        verifyCache.delete(binding.candidateSha256);
      }
    });
    verifyCache.set(binding.candidateSha256, promise);
    return promise;
  }

  function loadRoleBundleModule(binding: ActiveBinding): Promise<RoleBundleModule> {
    const cached = moduleCache.get(binding.candidateSha256);
    if (cached !== undefined) return cached;
    const specifier = pathToFileURL(candidateModulePath(binding.runtimePath, "role-bundle")).href;
    const promise = Promise.resolve(importModule(specifier));
    promise.catch(() => {
      if (moduleCache.get(binding.candidateSha256) === promise) {
        moduleCache.delete(binding.candidateSha256);
      }
    });
    moduleCache.set(binding.candidateSha256, promise);
    return promise;
  }

  /** P2-c mint — ordinary requests keep the fail-open W5/G4 behavior. A
   *  reserved task ticket takes the deliberate fail-closed branch: missing
   *  or rejecting desk validation aborts that native create without echoing
   *  the ticket. No seam, or an unknown family, means no handle for ordinary
   *  requests — those still return exactly as before P2-c. */
  async function mintFor(input: {
    provider: string;
    family: FamilyId | null;
    role: string;
    config: AgentCreateRequest["config"];
    env: Record<string, string>;
    taskCreateTicketContext?: DeskSeatTaskCreateTicketContext;
  }): Promise<string | null> {
    const seam = deps.deskMint;
    if (seam === undefined || input.family === null) {
      if (input.taskCreateTicketContext !== undefined) throw new Error("task create ticket cannot be validated by the desk mint seam");
      return null;
    }
    try {
      const out = await seam({
        provider: input.provider,
        family: input.family,
        role: input.role,
        cwd: input.config.cwd,
        env: input.env,
        ...(input.taskCreateTicketContext === undefined ? {} : { taskCreateTicketContext: input.taskCreateTicketContext }),
      });
      if (out === null && input.taskCreateTicketContext !== undefined) throw new Error("task create ticket claim was not accepted");
      return out === null ? null : out.handle;
    } catch {
      if (input.taskCreateTicketContext !== undefined) throw new Error("task create ticket claim could not be validated");
      return null;
    }
  }

  function taskCreateTicketContext(request: AgentCreateRequest): DeskSeatTaskCreateTicketContext | undefined {
    const hasTicket = request.env !== undefined && Object.hasOwn(request.env, DESK_TASK_CREATE_TICKET_KEY);
    if (!hasTicket) return undefined;
    const value = request.env?.[DESK_TASK_CREATE_TICKET_KEY];
    const config = request.config;
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value) || typeof config?.provider !== "string" ||
        typeof config?.cwd !== "string" || config.cwd.length === 0) {
      throw new Error("task create ticket hook context is invalid");
    }
    return {
      ticket: value,
      config: {
        provider: config.provider,
        model: typeof config.model === "string" ? config.model : null,
        cwd: config.cwd,
        modeId: typeof config.modeId === "string" ? config.modeId : null,
        thinkingOptionId: typeof config.thinkingOptionId === "string" ? config.thinkingOptionId : null,
        featureValues: config.featureValues ?? null,
      },
    };
  }

  function envAfterTicket(request: AgentCreateRequest, handle: string): Record<string, string> {
    const env = { ...(request.env ?? {}) };
    delete env[DESK_TASK_CREATE_TICKET_KEY];
    env[DESK_HANDLE_KEY] = handle;
    return env;
  }

  return {
    /** agent.create before-hook. Returns nothing for pass-through providers;
     *  throws (aborts the create) for slp-* providers whose role, binding or
     *  candidate cannot be resolved — never a silent unroled spawn. */
    async agentCreate(input: { request: AgentCreateRequest }) {
      const config = input.request.config;
      const provider = config?.provider;
      const taskTicketContext = taskCreateTicketContext(input.request);
      if (taskTicketContext !== undefined && (typeof provider !== "string" || !provider.startsWith("slp-"))) {
        throw new Error("task create ticket is unsupported for this native provider");
      }
      if (typeof provider !== "string" || !provider.startsWith("slp-")) return;
      // R2 (C10) — the devin wrapper path now grafts ONLY the desk handle
      // into request.env: no config change, no binding, no role bytes. A
      // failed or absent mint returns the request untouched, exactly as
      // before P2-c.
      const wrapper = DEVIN_PROVIDER.exec(provider);
      if (wrapper !== null) {
        const handle = await mintFor({
          provider,
          family: familyFromProviderId(provider),
          role: wrapper[2],
          config,
          env: input.request.env ?? {},
          ...(taskTicketContext === undefined ? {} : { taskCreateTicketContext: taskTicketContext }),
        });
        if (handle === null && taskTicketContext !== undefined) throw new Error("task create ticket claim is unavailable");
        if (handle === null) return;
        return {
          ...input.request,
          env: taskTicketContext === undefined ? { ...(input.request.env ?? {}), [DESK_HANDLE_KEY]: handle } : envAfterTicket(input.request, handle),
        };
      }
      const role = roleForCreate(provider, config.featureValues);
      if (role === null) return;
      const binding = deps.readActiveBinding();
      if (binding === null) {
        throw new Error(
          `SLP role injection cannot run for provider ${provider}: no active binding ` +
            "(the plugin has no verified candidate to render the role bundle from)",
        );
      }
      // O1: re-verify the published candidate before importing any of its
      // code — same verifyPublished the management plane uses, cached once
      // per sha. This also covers bin/slp-gate.mjs transitively: the gate
      // launcher execs it after this hook in the same launch flow.
      await verifyCandidateOnce(binding);
      const mod = await loadRoleBundleModule(binding);
      const bundle = mod.roleBundle(binding.runtimePath, role, {
        SLP_MANAGED_RUNTIME: "1",
        SLP_NODE_BIN: binding.nodePath,
        SLP_RUNTIME_ROOT: binding.runtimePath,
        SLP_DAEMON_HOME: binding.daemonHome,
      });
      const existing = config.systemPrompt;
      const systemPrompt =
        typeof existing === "string" && existing.length > 0
          ? bundle.instructions.endsWith("\n")
            ? bundle.instructions + existing
            : `${bundle.instructions}\n${existing}`
          : bundle.instructions;
      // P2-c — after every fail-closed gate has passed, mint the seat
      // membership; the handle joins the request env only after the
      // seat.mint commit (G1). No handle → the request as before P2-c.
      const handle = await mintFor({
        provider,
        family: familyFromProviderId(provider),
        role,
        config,
        env: input.request.env ?? {},
        ...(taskTicketContext === undefined ? {} : { taskCreateTicketContext: taskTicketContext }),
      });
      if (handle === null) {
        if (taskTicketContext !== undefined) throw new Error("task create ticket claim is unavailable");
        return {
          ...input.request,
          config: { ...config, systemPrompt },
        };
      }
      return {
        ...input.request,
        config: { ...config, systemPrompt },
        env: taskTicketContext === undefined ? { ...(input.request.env ?? {}), [DESK_HANDLE_KEY]: handle } : envAfterTicket(input.request, handle),
      };
    },

    /** agent.session_open before-hook: with the desk seam present, first
     *  bind the env-echoed handle for every managed slp-* open (the seam's
     *  GATE/JOIN cells decide whether anything happens), then overlay as
     *  before. Without the seam the hook stays synchronous and returns
     *  byte-for-byte the pre-P2-c result. The overlay itself is unchanged:
     *  a per-open grant only; all other fields return unchanged (the host
     *  rejects changes beyond env). */
    sessionOpen(input: { request: SessionOpenRequest }) {
      const request = input.request;
      const overlay = () => {
        const owned = HOOK_FAMILY_PROVIDER.exec(request.provider);
        if (owned === null) return;
        return {
          ...request,
          env: {
            ...(request.env ?? {}),
            SLP_SESSION_OPEN_GRANT: grantToken(request),
          },
        };
      };
      const seam = deps.deskBind;
      if (seam === undefined || !request.provider.startsWith("slp-")) return overlay();
      // P2-c — bind before the overlay (§5); fail-open belt: the seam never
      // rejects, and a belt catch keeps a seam bug from aborting the open.
      return (async () => {
        try {
          await seam({
            agentId: request.agentId,
            workspaceId: request.workspaceId,
            provider: request.provider,
            cwd: request.cwd,
            reason: request.reason,
            purpose: request.purpose,
            env: request.env ?? {},
          });
        } catch { /* fail-open: the open proceeds unbound */ }
        return overlay();
      })();
    },
  };
}
