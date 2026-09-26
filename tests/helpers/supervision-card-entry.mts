// Bundle entry for the Supervision-card hook tests — esbuild stitches the
// real hook against the RN/Paseo boundary stubs so node:test can drive it
// through react-test-renderer.
export { useSupervisionCard } from "../../plugin/client/cards/supervision.tsx";
export { paseoState } from "./paseo-client-stub.mjs";
export {
  formFromConfig,
  leadChecked,
  leadRows,
  statusLine,
  toggleLead,
} from "../../plugin/client/supervision-form.ts";
export { isDaemonHome, targetKey } from "../../plugin/client/manager-state.ts";
