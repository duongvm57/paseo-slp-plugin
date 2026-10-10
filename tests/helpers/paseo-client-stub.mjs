// @getpaseo/plugin/client boundary stub for node:test renders — the host
// supplies the real context; tests inject a minimal paseo surface instead.
export const paseoState = { current: null };

export function usePaseo() {
  if (paseoState.current === null) throw new Error("paseo stub: install a mock via paseoState.current");
  return paseoState.current;
}

export function useRpc(contract) {
  return input => usePaseo().rpc(contract, input);
}

export function useWorkspace(workspaceId, selector) {
  const value = paseoState.current?.workspaces?.current?.(workspaceId);
  return value ? selector(value) : null;
}
