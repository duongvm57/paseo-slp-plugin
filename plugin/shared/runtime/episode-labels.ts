// Advisory observations, never native identity or authority gates.
export const RETROSPECTIVE_LABELS = [
  'slp.role', 'slp.disposition', 'slp.runtime-sha', 'slp.protocol-sha',
  'slp.episode-id', 'slp.episode-root', 'slp.handoff-from',
] as const;
export const retrospectiveLabel = (key: string): boolean => RETROSPECTIVE_LABELS.some(label => label === key);
