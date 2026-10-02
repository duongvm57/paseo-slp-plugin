// Observational wire shape; untouched fields pass through every adapter.
interface ProtocolMessage {
  method?: string;
  type?: string;
  params?: {
    sessionId?: unknown;
    prompt?: unknown[];
    developerInstructions?: unknown;
    collaborationMode?: {
      settings?: {
        developer_instructions?: unknown;
      };
    };
  };
  request?: {
    subtype?: string;
    appendSystemPrompt?: unknown;
    systemPrompt?: {
      append?: unknown;
    } | null;
  };
}
// Only instruction-bearing requests change. Host lifecycle and permissions pass through.
export function piRoleArgs(args: string[], instruction: string) {
  // Pi accepts repeated append flags, preserving host prompt sources and extensions.
  // Insert before -- so the policy cannot become a positional user message.
  const end = args.indexOf('--');
  const options = end < 0 ? args : args.slice(0, end);
  if (options.some(arg => ['--help', '-h', '--version', '-v'].includes(arg))) return [...args];
  const index = end < 0 ? args.length : end;
  return [...args.slice(0, index), '--append-system-prompt', instruction, ...args.slice(index)];
}

export function injectRole<T extends ProtocolMessage>(message: T, instruction: string): T {
  if (!['thread/start', 'thread/resume', 'turn/start'].includes(message?.method!)) return message;
  const result = structuredClone(message);
  const params = result.params ??= {};
  const append = (value: unknown) => typeof value === 'string' && value.includes(instruction)
    ? value : [value, instruction].filter(Boolean).join('\n\n');
  // Current Codex keeps instructions on the thread; older hosts also send turn overrides.
  if (message.method !== 'turn/start' || Object.hasOwn(params, 'developerInstructions')) {
    params.developerInstructions = append(params.developerInstructions);
  }
  if (params.collaborationMode?.settings) {
    params.collaborationMode.settings.developer_instructions = append(params.collaborationMode.settings.developer_instructions);
  }
  return result;
}

// The Claude Agent SDK opens each query with an `initialize` control request on
// stdin. Under SDK 0.3.246 a preset options.systemPrompt is hoisted before the
// wire: the request carries top-level request.appendSystemPrompt and no
// systemPrompt key. The request.systemPrompt.append branch is defensive cover
// for emitters that forward the preset object verbatim; when both fields are
// present the policy joins both so neither carries stale text. Every other
// frame passes through untouched.
export function claudeRolePrompt<T extends ProtocolMessage>(message: T, instruction: string): T {
  if (message?.type !== 'control_request' || message?.request?.subtype !== 'initialize') return message;
  const result = structuredClone(message);
  const request = result.request!;
  const append = (value: unknown) => typeof value === 'string' && value.includes(instruction)
    ? value : [value, instruction].filter(Boolean).join('\n\n');
  const systemPrompt = request.systemPrompt;
  const preset = systemPrompt !== null && typeof systemPrompt === 'object' && !Array.isArray(systemPrompt)
    && (systemPrompt.append === undefined || typeof systemPrompt.append === 'string');
  if (preset) systemPrompt.append = append(systemPrompt.append);
  if (!preset || request.appendSystemPrompt !== undefined) {
    request.appendSystemPrompt = append(request.appendSystemPrompt);
  }
  return result;
}

// Generic ACP carries policy in conversation history. Every prompt gets core;
// first/re-armed prompts also get entry helpers and the measured carrier.
// This requires no host compaction event; `seen` only controls carrier delivery.
export function acpRolePrompt<T extends ProtocolMessage>(message: T, delivery: { anchor(): string; entry(options?: { explicitLanguageState?: boolean }): string }, seen: Set<string>): T {
  const sessionId = message?.params?.sessionId;
  if (['session/load', 'session/resume', 'session/fork'].includes(message?.method!)) {
    if (typeof sessionId === 'string') seen.delete(sessionId);
    return message;
  }
  if (message?.method !== 'session/prompt') return message;
  if (typeof sessionId !== 'string' || !Array.isArray(message.params!.prompt)) throw new Error('Malformed session/prompt');
  const instruction = seen.has(sessionId) ? delivery.anchor() : delivery.entry({ explicitLanguageState: true });
  const result = structuredClone(message);
  result.params!.prompt = [{ type: 'text', text: instruction }, ...result.params!.prompt!];
  seen.add(sessionId);
  return result;
}
