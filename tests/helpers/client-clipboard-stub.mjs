export const clipboardState = { copy: async () => {} };
export function copyText(text) { return clipboardState.copy(text); }
