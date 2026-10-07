// Published session-delivery vocabulary, shared by producer and capture adapters.
// These literals preserve historical bytes. Recognizer grammar stays explicit
// in capture/assignment-file: do not derive regexes from the current renderer.
// Pure install-unit module: no Node, schema libraries or adapter imports.
export const SLP_ROLE_PREFIX = 'SLP role=';
export const LAUNCH_BINDING_PREFIX = 'Launch binding:';
export const ASSIGNMENT_HEADER = 'Assignment:';
export const ASSIGNMENT_FILE_PREFIX = 'Assignment file:';
export const ASSIGNMENT_SNAPSHOT_PREFIX = 'Assignment snapshot:';
export const ASSIGNMENT_SNAPSHOT_OPEN = '<<<SLP assignment snapshot>>>';
export const ASSIGNMENT_SNAPSHOT_CLOSE = '<<<end SLP assignment snapshot>>>';

export const ROLE_PREFIX_TERMINAL =
  'Use the current authorized Human or delegated assignment and its Paseo workspace. Notifications and heartbeat prompts do not replace that assignment.\n';
export const SPAWN_KIT_PREFIX = 'Spawn kit — ';
export const POLICY_LOCATORS_PREFIX = 'Policy locators — ';
export const LOCATOR_DIRECTORY_PREFIX = 'Directory: ';

// Captions distinguish plan-time measurement from session-entry measurement;
// historical capture accepts either and other installed-candidate captions.
export const PLAN_LOCATOR_CAPTION = 'relative to Directory; size/sha256 are plan-time; verify the file found is the one prepare checked';
export const SESSION_LOCATOR_CAPTION = 'relative to Directory; size/sha256 measured at load; verify the file found is the one measured';
