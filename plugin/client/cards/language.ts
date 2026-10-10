// Language-card ownership (wave 11 S3b/D): the card owns its draft state,
// prefill effect and apply handler; the shell supplies the target, the
// status view it prefills from, the RPC caller and the shared
// refresh/lastError plumbing. Toggle off applies immediately (nothing to
// type); toggle on waits for the Apply press so an empty value is never
// written.
import { useEffect, useState } from "react";
import type { StatusResult, TargetValue } from "../../shared/contracts.ts";
import { useTargetLifetime } from "../target-async.ts";
import { errorMessage } from "../manager-state.ts";

export function useLanguageCard({ target, targetKey, isCurrentKey, statusView, callSetLanguage, refresh, update }: {
  target: TargetValue | null;
  targetKey: string | null;
  isCurrentKey: (key: string) => boolean;
  statusView: StatusResult | null;
  callSetLanguage: (input: { schemaVersion: 1; target: TargetValue; value: string | null }) => Promise<unknown>;
  refresh: (target: TargetValue) => void;
  update: (patch: { lastError: string | null }, target: TargetValue) => void;
}) {
  const capture = useTargetLifetime(targetKey);
  const [languageOn, setLanguageOn] = useState(false);
  const [languageValue, setLanguageValue] = useState("");
  const [languageDirty, setLanguageDirty] = useState(false);
  const [languageBusy, setLanguageBusy] = useState(false);

  // Prefill the language control from status until the Human edits it —
  // the same discipline the routing and pool forms use.
  useEffect(() => {
    if (languageDirty) return;
    const stored = statusView?.communicationLanguage ?? null;
    setLanguageOn(stored !== null);
    setLanguageValue(stored ?? "");
  }, [statusView, languageDirty]);

  // A stale op must not clear the busy flag of a newer op on the displayed
  // target — the target-switch reset releases the abandoned flag instead.
  useEffect(() => {
    setLanguageBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey captures target
  }, [targetKey]);

  // Toggle off applies immediately (nothing to type); toggle on waits for
  // the Apply press so an empty value is never written.
  const applyLanguage = async (value: string | null) => {
    if (!target || !targetKey) return;
    const ticket = capture();
    setLanguageBusy(true);
    try {
      await callSetLanguage({ schemaVersion: 1, target, value });
      // Stale-write guard (the issueKey discipline the pool ops use): an
      // apply issued on the previous target must not clear the displayed
      // target's dirty flag — the prefill effect would then overwrite its
      // edits. refresh() itself is target-bound and safe either way.
      if (!ticket.isCurrent()) return;
      setLanguageDirty(false);
      void refresh(target);
    } catch (error) {
      update({ lastError: errorMessage(error) }, target);
    } finally {
      if (ticket.isCurrent()) setLanguageBusy(false);
    }
  };

  const onToggle = (next: boolean) => {
    setLanguageOn(next);
    if (next) {
      setLanguageDirty(true);
    } else {
      setLanguageDirty(false);
      void applyLanguage(null);
    }
  };
  const onChangeText = (text: string) => {
    setLanguageDirty(true);
    setLanguageValue(text);
  };
  const onApply = () => void applyLanguage(languageValue.trim());

  return {
    on: languageOn,
    value: languageValue,
    busy: languageBusy,
    disabled: !target || languageBusy,
    onToggle,
    onChangeText,
    onApply,
  };
}
