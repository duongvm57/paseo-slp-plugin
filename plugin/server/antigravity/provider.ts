// Adapted from getpaseo/paseo v0.12.0, Antigravity provider (Apache-2.0).
// See LICENSE in this directory; native wire behavior follows that release.
import { createHash } from "node:crypto";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { getCatalog, getStatus } from "./internal/catalog.ts";
import { Session } from "./internal/session.ts";
import { AntigravityError } from "./internal/wire.ts";

const capabilities = [
  "prompt.message",
  "prompt.image",
  "session.configure",
  "session.persistence",
] as const;

// Older hosts also require a default command to resolve an explicit override.
// This inert fallback can only exit unsuccessfully; it never invokes agy.
const unconfiguredScript = "throw new Error('SLP_ANTIGRAVITY_UNCONFIGURED')";
function configuredLaunch(launch: ProviderLaunch | undefined): launch is ProviderLaunch {
  return launch !== undefined && !launch.args.includes(unconfiguredScript);
}

export function createAntigravityProvider(id = "antigravity", label = "Antigravity"): ProviderRegistration {
  return {
    id,
    label,
    // Optional on host 0.12; spread keeps this additive field compatible
    // with the pinned 0.11.2 SDK type. Older hosts use the inert guard below.
    ...{ requiresConfiguration: true },
    command: [process.execPath, "--eval", unconfiguredScript],
    // Activation supplies the verified gate as an override. A default launch
    // is rejected before discovery/connect, even without requiresConfiguration.
    description: "Antigravity CLI on your host",
    async status({ launch }) {
      if (!configuredLaunch(launch))
        return {
          available: false,
          diagnostic: "SLP Antigravity has no configured launcher. Activate or rebind SLP before opening a session.",
        };
      return getStatus(launch);
    },
    async getCatalogCacheKey({ launch }) {
      if (!configuredLaunch(launch)) return undefined;
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([launch.command, launch.args, env]))
        .digest("hex");
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new AntigravityError("Provider protocol version 1 is required");
      if (!configuredLaunch(request.launch))
        throw new AntigravityError("The daemon must supply the Antigravity launch");
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      return createConnection(request.launch, negotiated);
    },
  };
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let discovered: ProviderCatalog | null = null;
  let closed = false;
  let pending = Promise.resolve();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }
  function catalog(): ProviderCatalog {
    if (discovered === null)
      throw new AntigravityError("Antigravity catalog has not been discovered");
    return discovered;
  }
  function session(id: string): Session {
    const found = sessions.get(id);
    if (!found) throw new AntigravityError(`Unknown Antigravity session: ${id}`);
    return found;
  }
  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        discovered = await getCatalog(launch, input.cwd);
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: catalog(),
        });
        return;
      case "session.open": {
        if (sessions.has(input.sessionId))
          throw new AntigravityError(`Session already exists: ${input.sessionId}`);
        if (discovered === null) discovered = await getCatalog(launch, input.config.cwd);
        const opened = new Session({
          id: input.sessionId,
          config: input.config,
          persistence: input.persistence,
          catalog,
          launch,
          emit,
        });
        sessions.set(input.sessionId, opened);
        try {
          await opened.open(input.requestId, negotiated);
        } catch (error) {
          sessions.delete(input.sessionId);
          await opened.close();
          throw error;
        }
        return;
      }
      case "session.prompt":
        await session(input.sessionId).prompt(input.prompt);
        return;
      case "session.configure":
        session(input.sessionId).configure(input.changes);
        break;
      case "session.interrupt":
        await session(input.sessionId).interrupt();
        break;
      case "session.close": {
        await session(input.sessionId).close();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      }
      default:
        throw new AntigravityError(`Unsupported Antigravity operation: ${input.type}`);
    }
    emit({ type: "request.completed", requestId: input.requestId });
  }
  function failed(input: ProviderInput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof AntigravityError ? error.code : "ANTIGRAVITY_ERROR";
    if (input.type === "session.prompt")
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message, code } },
      });
    else if ("requestId" in input)
      emit({ type: "request.failed", requestId: input.requestId, error: { message, code } });
  }
  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new AntigravityError("Antigravity connection is closed");
      requireProviderCapabilities(negotiated, input);
      pending = pending
        .then(async () => {
          if (!closed) await dispatch(input);
          return undefined;
        })
        .catch((error) => failed(input, error));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await Promise.all([...sessions.values()].map((opened) => opened.close()));
      sessions.clear();
      listeners.clear();
    },
  };
}
