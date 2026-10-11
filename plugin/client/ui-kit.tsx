// Themed primitives for the manager surface — plain React Native views
// rather than the settings-form kit so the flow can read like a wizard.
// Presentation only: state and effects live in the shell (ManagerSurface).
import { useState } from "react";
import type { ReactNode } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { SeatArchetype } from "../shared/archetypes.ts";
import type { CatalogOptionValue } from "../shared/contracts.ts";

export type Colors = PluginTheme["colors"];

// RN-web delivers `hovered`/`focused` through the Pressable style callback at
// runtime; RN's PressableStateCallbackType declares only `pressed`, so the
// extras are typed optional here — a host that doesn't deliver them simply
// skips the hover/focus styling while `pressed` keeps working.
export type ControlState = { pressed: boolean; hovered?: boolean; focused?: boolean };

// The host theme has no focus slot — the accent is the interactive hue and
// carries the visible focus ring (the mockup's focus blue → colors.accent).
// Likewise there is no accent-tint slot: tinted fills use colors.surface2
// with the accent carried by the text/border (documented mapping).
export const focusRing = (colors: Colors) => ({
  outlineStyle: "solid" as const,
  outlineWidth: 3,
  outlineColor: colors.accent,
  outlineOffset: 2,
});
// ---------------------------------------------------------------------------
// Small themed primitives — the surface uses plain React Native views rather
// than the settings-form kit so the flow can read like a wizard.
// ---------------------------------------------------------------------------

export function Card({ colors, title, subtitle, trailing, children }: {
  colors: Colors;
  title?: string;
  subtitle?: string;
  /** Header-side slot — the state badge a card reports (mockup card-head). */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={[styles.card, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
      {title || trailing ? (
        <View style={styles.cardHeadRow}>
          {title ? <Text style={[styles.cardTitle, { color: colors.foreground, flex: 1, minWidth: 180 }]}>{title}</Text> : null}
          {trailing}
        </View>
      ) : null}
      {subtitle ? <Text style={[styles.muted, { color: colors.foregroundMuted }]}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

/** Compact status badge — the mockup's .badge tones mapped onto the host's
 *  semantic color slots (no hardcoded palette). */
export function Badge({ colors, label, tone = "neutral" }: {
  colors: Colors;
  label: string;
  tone?: "draft" | "good" | "managed" | "bad" | "neutral";
}) {
  const color = tone === "draft" ? colors.statusWarning
    : tone === "good" ? colors.statusSuccess
    : tone === "managed" ? colors.accent
    : tone === "bad" ? colors.statusDanger
    : colors.foregroundMuted;
  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: colors.surface2 }]}>
      <Text style={[styles.badgeLabel, { color }]}>{label}</Text>
    </View>
  );
}

export function Button({ colors, label, onPress, disabled, kind = "ghost" }: {
  colors: Colors;
  label: string;
  onPress(): void;
  disabled?: boolean;
  kind?: "primary" | "ghost" | "danger";
}) {
  const base = kind === "primary"
    ? { backgroundColor: colors.accent, borderColor: colors.accent }
    : kind === "danger"
      ? { backgroundColor: "transparent", borderColor: colors.statusDanger }
      : { backgroundColor: colors.surface2, borderColor: colors.border };
  const textColor = kind === "primary"
    ? colors.accentForeground
    : kind === "danger"
      ? colors.statusDanger
      : colors.foreground;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      style={(state: ControlState) => [
        styles.button,
        base,
        // No darker-accent slot exists — a primary hover dims slightly while
        // ghost/danger hover take the tint fill (mockup hover → surface2).
        state.hovered && !disabled && kind !== "primary" && { backgroundColor: colors.surface2, borderColor: colors.foregroundMuted },
        state.hovered && !disabled && kind === "primary" && { opacity: 0.88 },
        state.focused && focusRing(colors),
        disabled && styles.buttonDisabled,
        state.pressed && !disabled && { opacity: 0.75 },
      ]}
    >
      <Text style={[styles.buttonLabel, { color: textColor }]}>{label}</Text>
    </Pressable>
  );
}

export function CheckRow({ colors, checked, onToggle, title, hint, disabled }: {
  colors: Colors;
  checked: boolean;
  onToggle(next: boolean): void;
  title: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => onToggle(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: disabled === true }}
      style={(state: ControlState) => [
        styles.checkRow,
        state.hovered && !disabled && { backgroundColor: colors.surface2 },
        state.focused && focusRing(colors),
        disabled && { opacity: 0.45 },
        state.pressed && !disabled && { opacity: 0.75 },
      ]}
    >
      <View style={[
        styles.checkbox,
        { borderColor: checked ? colors.accent : colors.border },
        checked && { backgroundColor: colors.accent },
      ]}>
        {checked ? <Text style={[styles.checkmark, { color: colors.accentForeground }]}>✓</Text> : null}
      </View>
      <View style={styles.checkText}>
        <Text style={[styles.checkTitle, { color: colors.foreground }]}>{title}</Text>
        {hint ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

export function SwitchRow({ colors, checked, onToggle, title, hint, disabled }: {
  colors: Colors;
  checked: boolean;
  onToggle(next: boolean): void;
  title: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => onToggle(!checked)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked, disabled }}
      style={(state: ControlState) => [
        styles.checkRow,
        state.hovered && !disabled && { backgroundColor: colors.surface2 },
        state.focused && focusRing(colors),
        disabled && { opacity: 0.45 },
        state.pressed && !disabled && { opacity: 0.75 },
      ]}
    >
      <View style={[
        styles.switchTrack,
        { backgroundColor: checked ? colors.accent : colors.border },
      ]}>
        <View style={[
          styles.switchThumb,
          { backgroundColor: checked ? colors.accentForeground : colors.foregroundMuted },
          checked ? styles.switchThumbOn : styles.switchThumbOff,
        ]} />
      </View>
      <View style={styles.checkText}>
        <Text style={[styles.checkTitle, { color: colors.foreground }]}>{title}</Text>
        {hint ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

export function ChipSelect<T extends string>({ colors, value, options, onChange, disabled, variant = "pill" }: {
  colors: Colors;
  value: T;
  options: readonly { label: string; value: T }[];
  onChange(next: T): void;
  disabled?: boolean;
  // "choice" is the mockup's .choice fieldset chip — square-ish, muted until
  // selected, then accent border/text over a tinted (surface2) fill instead
  // of the pill's solid accent.
  variant?: "pill" | "choice";
}) {
  return (
    <View style={variant === "choice" ? styles.choiceRow : styles.chipRow}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            disabled={disabled}
            hitSlop={{ top: 3, bottom: 3, left: 0, right: 0 }}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled: disabled === true }}
            style={(state: ControlState) => variant === "choice"
              ? [
                  styles.choice,
                  {
                    borderColor: active ? colors.accent : colors.border,
                    backgroundColor: active ? colors.surface2 : colors.surface0,
                  },
                  state.hovered && !disabled && !active && { backgroundColor: colors.surface2 },
                  state.focused && focusRing(colors),
                  disabled && { opacity: 0.45 },
                  state.pressed && !disabled && { opacity: 0.75 },
                ]
              : [
                  styles.chip,
                  { borderColor: active ? colors.accent : colors.border },
                  active && { backgroundColor: colors.accent },
                  state.hovered && !disabled && !active && { backgroundColor: colors.surface2 },
                  state.focused && focusRing(colors),
                  disabled && { opacity: 0.45 },
                  state.pressed && !disabled && { opacity: 0.75 },
                ]}
          >
            <Text
              style={variant === "choice"
                ? [styles.choiceLabel, { color: active ? colors.accent : colors.foregroundMuted }]
                : [styles.chipLabel, { color: active ? colors.accentForeground : colors.foreground }]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Field({ colors, label, hint, value, onChangeText, placeholder, disabled, secure, multiline }: {
  colors: Colors;
  label: string;
  hint?: string;
  value: string;
  onChangeText(text: string): void;
  placeholder?: string;
  disabled?: boolean;
  secure?: boolean;
  multiline?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.foregroundMuted}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure === true}
        multiline={multiline === true}
        accessibilityLabel={label}
        accessibilityState={{ disabled: disabled === true }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          { borderColor: focused ? colors.accent : colors.border, color: colors.foreground, backgroundColor: colors.surface0 },
          multiline === true && styles.inputMultiline,
          disabled && { opacity: 0.5 },
        ]}
      />
      {hint ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{hint}</Text> : null}
    </View>
  );
}

/** Searchable single-select for large catalogs (model lists reach hundreds)
 *  rendered as the mockup's select-box: a bordered row showing the current
 *  label with a "Change model ⌄" link. Expanding opens the filter + option
 *  list IN PLACE without clearing the value, plus a "Provider default" entry
 *  and a manual-ID disclosure for ids the catalog doesn't list. */
export function OptionPicker({ colors, label, hint, options, value, onChange, onOpen, disabled, placeholder }: {
  colors: Colors;
  label: string;
  hint?: string;
  options: readonly CatalogOptionValue[];
  value: string;
  onChange(next: string): void;
  onOpen?(): void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filterFocus, setFilterFocus] = useState(false);
  const [manualFocus, setManualFocus] = useState(false);
  const selected = options.find(option => option.id === value);
  const filtered = query.trim() === ""
    ? options
    : options.filter(option => `${option.id} ${option.label}`.toLowerCase().includes(query.trim().toLowerCase()));
  const shown = filtered.slice(0, 60);
  // A stored value the catalog doesn't list still displays — never let the
  // picker look empty while a real value is applied.
  const effective = selected ?? (value !== "" ? { id: value, label: value } : undefined);
  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>{label}</Text>
      <View style={[styles.selectBox, { borderColor: colors.border, backgroundColor: colors.surface0 }]}>
        <Pressable
          onPress={() => { if (!open) onOpen?.(); setOpen(current => !current); setQuery(""); }}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={open ? `Close ${label}` : `Change ${label.toLowerCase()}`}
          accessibilityState={{ expanded: open, disabled: disabled === true }}
          style={(state: ControlState) => [
            styles.selectBoxRow,
            state.hovered && !disabled && { backgroundColor: colors.surface2 },
            // The select-box clips its children — the ring insets instead of
            // drawing outside where overflow:hidden would erase it.
            state.focused && { ...focusRing(colors), outlineOffset: -2 },
          ]}
        >
          <Text style={[styles.pickerSelectedLabel, { color: colors.foreground, fontWeight: "600" }]} numberOfLines={1}>
            {effective ? effective.label : "Provider default"}
          </Text>
          <Text style={[styles.selectBoxLink, { color: colors.accent }]}>
            {open ? "Close ⌃" : `Change ${label.toLowerCase()} ⌄`}
          </Text>
        </Pressable>
        {open ? (
          <View style={[styles.modelList, { borderTopColor: colors.border }]}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={placeholder ?? "Filter…"}
              placeholderTextColor={colors.foregroundMuted}
              editable={!disabled}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={`Filter ${label}`}
              onFocus={() => setFilterFocus(true)}
              onBlur={() => setFilterFocus(false)}
              style={[styles.input, { borderColor: filterFocus ? colors.accent : colors.border, color: colors.foreground, backgroundColor: colors.surface0 }, disabled && { opacity: 0.5 }]}
            />
            <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
              {shown.map(option => (
                <Pressable
                  key={option.id}
                  onPress={() => pick(option.id)}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${option.label !== option.id ? `${option.label} ${option.id}` : option.id}`}
                  style={(state: ControlState) => [
                    styles.pickerRow,
                    (state.hovered || state.pressed) && !disabled && { backgroundColor: colors.surface2 },
                    state.focused && focusRing(colors),
                  ]}
                >
                  <Text style={[styles.pickerRowLabel, { color: colors.foreground }]} numberOfLines={1}>
                    {option.label}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => pick("")}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel="Select Provider default"
                style={(state: ControlState) => [
                  styles.pickerRow,
                  (state.hovered || state.pressed) && !disabled && { backgroundColor: colors.surface2 },
                  state.focused && focusRing(colors),
                ]}
              >
                <Text style={[styles.pickerRowLabel, { color: colors.foregroundMuted }]}>Provider default</Text>
              </Pressable>
              {filtered.length === 0 ? (
                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted, padding: 10 }]}>No matches.</Text>
              ) : null}
            </ScrollView>
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              {filtered.length} option{filtered.length === 1 ? "" : "s"}{filtered.length > shown.length ? ` — showing first ${shown.length}` : ""}
            </Text>
            <Pressable
              onPress={() => setManualOpen(current => !current)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel="Enter model ID manually"
              accessibilityState={{ expanded: manualOpen, disabled: disabled === true }}
              style={(state: ControlState) => [
                styles.pickerRow,
                (state.hovered || state.pressed) && !disabled && { backgroundColor: colors.surface2 },
                state.focused && focusRing(colors),
              ]}
            >
              <Text style={[styles.mutedSmall, { color: colors.accent, fontWeight: "600" }]}>
                {manualOpen ? "▾" : "▸"} Enter model ID manually
              </Text>
            </Pressable>
            {manualOpen ? (
              <TextInput
                value={value}
                onChangeText={onChange}
                placeholder="Model ID — e.g. swe-2-max"
                placeholderTextColor={colors.foregroundMuted}
                editable={!disabled}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={`${label} ID`}
                onFocus={() => setManualFocus(true)}
                onBlur={() => setManualFocus(false)}
                style={[styles.input, { borderColor: manualFocus ? colors.accent : colors.border, color: colors.foreground, backgroundColor: colors.surface0 }, disabled && { opacity: 0.5 }]}
              />
            ) : null}
          </View>
        ) : null}
      </View>
      {hint ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{hint}</Text> : null}
    </View>
  );
}

export function Collapse({ colors, title, subtitle, open, onToggle, children }: {
  colors: Colors;
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle(next: boolean): void;
  children: ReactNode;
}) {
  return (
    <View style={[styles.card, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
      <Pressable
        onPress={() => onToggle(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={(state: ControlState) => [
          styles.collapseHeader,
          state.hovered && { backgroundColor: colors.surface2 },
          state.focused && focusRing(colors),
          state.pressed && { opacity: 0.75 },
        ]}
      >
        <Text style={[styles.collapseChevron, { color: colors.foregroundMuted }]}>{open ? "▾" : "▸"}</Text>
        <View style={styles.collapseHeaderText}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>{title}</Text>
          {subtitle ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{subtitle}</Text> : null}
        </View>
      </Pressable>
      {open ? <View style={styles.collapseBody}>{children}</View> : null}
    </View>
  );
}

/** One archetype row in the standard-seat picker (mockup pick-row): compact
 *  id + badge, the primary add/open action, and notes + custom creation
 *  tucked behind a per-row expandable. */
export function SeatTemplateRow({ colors, archetype, exists, onAdd, onCustom, disabled }: {
  colors: Colors;
  archetype: SeatArchetype;
  exists: boolean;
  onAdd(): void;
  onCustom(): void;
  disabled?: boolean;
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  return (
    <View style={[styles.pickRow, { borderTopColor: colors.border }]}>
      <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
        <Text style={[styles.checkTitle, styles.mono, { color: colors.foreground }]} numberOfLines={1}>
          {archetype.id}
        </Text>
        <Badge colors={colors} label={exists ? "In draft" : "Standard"} tone={exists ? "neutral" : "managed"} />
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button
          colors={colors}
          kind="primary"
          label={exists ? "Already present — open seat" : "Add a standard seat"}
          onPress={onAdd}
          disabled={disabled}
        />
        <Pressable
          onPress={() => setNotesOpen(current => !current)}
          accessibilityRole="button"
          accessibilityLabel="Notes and custom option"
          accessibilityState={{ expanded: notesOpen }}
          style={(state: ControlState) => [
            { borderRadius: 6, paddingVertical: 3, paddingHorizontal: 6, marginLeft: -6 },
            state.hovered && { backgroundColor: colors.surface2 },
            state.focused && focusRing(colors),
            state.pressed && { opacity: 0.6 },
          ]}
        >
          <Text style={[styles.mutedSmall, { color: colors.accent }]}>
            {notesOpen ? "Hide notes" : "Notes & custom option"}
          </Text>
        </Pressable>
      </View>
      {notesOpen ? (
        <View style={{ gap: 6 }}>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{archetype.notes}</Text>
          <View>
            <Button
              colors={colors}
              label="Create a custom seat from template"
              onPress={onCustom}
              disabled={disabled}
            />
          </View>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            Custom seats receive no package token updates.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function KV({ colors, label, value }: { colors: Colors; label: string; value: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={[styles.kvLabel, { color: colors.foregroundMuted }]}>{label}</Text>
      <Text style={[styles.kvValue, { color: colors.foreground }]} selectable>{value}</Text>
    </View>
  );
}

const STATE_TONE: Record<string, keyof Colors> = {
  ACTIVE: "statusSuccess",
  ACTIVATING: "accent",
  DEACTIVATING: "accent",
  RECOVERY_REQUIRED: "statusWarning",
};
export function StatePill({ colors, state }: { colors: Colors; state: string | null }) {
  const tone = state ? STATE_TONE[state] ?? "foregroundMuted" : "foregroundMuted";
  const color = colors[tone];
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillLabel, { color }]}>{state ?? "unknown"}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 10 },
  cardTitle: { fontSize: 18, fontWeight: "600" },
  muted: { fontSize: 14, lineHeight: 21 },
  mutedSmall: { fontSize: 12, lineHeight: 16 },
  button: { minHeight: 44, justifyContent: "center", borderWidth: 1, borderRadius: 7, paddingVertical: 8, paddingHorizontal: 12, alignItems: "center", alignSelf: "flex-start" },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { fontSize: 14, fontWeight: "600" },
  checkRow: { minHeight: 44, flexDirection: "row", alignItems: "flex-start", gap: 10, borderRadius: 6, padding: 2 },
  checkbox: { width: 20, height: 20, borderWidth: 1.5, borderRadius: 5, alignItems: "center", justifyContent: "center", marginTop: 1 },
  switchTrack: { width: 32, height: 20, borderRadius: 10, justifyContent: "center", paddingHorizontal: 3, marginTop: 1 },
  switchThumb: { width: 14, height: 14, borderRadius: 7 },
  switchThumbOn: { alignSelf: "flex-end" },
  switchThumbOff: { alignSelf: "flex-start" },
  checkmark: { fontSize: 13, fontWeight: "700" },
  checkText: { flex: 1, gap: 2 },
  checkTitle: { fontSize: 14, fontWeight: "500" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12 },
  chipLabel: { fontSize: 13, fontWeight: "500" },
  field: { gap: 5 },
  fieldLabel: { fontSize: 13, fontWeight: "500" },
  roleBox: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 10 },
  roleTitle: { fontSize: 14, fontWeight: "600" },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, fontSize: 14 },
  inputMultiline: { minHeight: 72, textAlignVertical: "top" },
  collapseHeader: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 6, padding: 2 },
  collapseChevron: { fontSize: 14, width: 14 },
  collapseHeaderText: { flex: 1, gap: 2 },
  collapseBody: { gap: 10, paddingTop: 2 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  kvLabel: { fontSize: 13 },
  kvValue: { fontSize: 13, flexShrink: 1, textAlign: "right" },
  pill: { borderWidth: 1.5, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10 },
  pillLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 0.4 },
  conflictBox: { borderWidth: 1, borderRadius: 8, padding: 10, gap: 6 },
  divider: { borderTopWidth: 1, marginVertical: 2 },
  pickerSelectedLabel: { fontSize: 14, flexShrink: 1 },
  pickerRow: { minHeight: 44, justifyContent: "center", paddingVertical: 8, paddingHorizontal: 10 },
  pickerRowLabel: { fontSize: 13 },
  // Draft-clarity mockup tokens mapped onto host theme slots — card-head
  // row, badges, tinted notices, mono identity text, underlined token links.
  cardHeadRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  badge: { borderWidth: 1, borderRadius: 5, paddingVertical: 2, paddingHorizontal: 7 },
  badgeLabel: { fontSize: 11, fontWeight: "700", lineHeight: 16 },
  eyebrow: { fontSize: 11, fontWeight: "700", letterSpacing: 1.6, textTransform: "uppercase" },
  noticeBox: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 6 },
  confirmBox: { borderWidth: 1, borderRadius: 7, padding: 12, gap: 8 },
  mono: { fontFamily: "monospace" },
  tokenText: { fontFamily: "monospace", fontSize: 12, textDecorationLine: "underline" },
  savedProvider: { borderLeftWidth: 3, borderRadius: 6, padding: 12, gap: 4 },
  seatState: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  pickRow: { borderTopWidth: 1, paddingVertical: 10, gap: 6 },
  // Visual-system wave — routing headline, in-surface nav strip, the
  // two-column profile panels, choice chips, and the select-box model row.
  // All geometry/type from manager-reviewed.html; fills map to surface2
  // (no accent-tint slot) and the focus ring to accent (no focus slot).
  routingHeadline: { fontSize: 27, fontWeight: "700", letterSpacing: -0.5, lineHeight: 33 },
  navStrip: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  navItem: { minHeight: 44, justifyContent: "center", paddingVertical: 9, paddingHorizontal: 12, borderRadius: 6 },
  navItemCompact: { paddingVertical: 8, paddingHorizontal: 10 },
  navLabel: { fontSize: 13, fontWeight: "500" },
  // Two bases341 + gap18 wrap below700px using native layout alone.
  // A narrow container clamps each panel, including phones under341px.
  profileGrid: { gap: 18, flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start" },
  profilePanel: { borderWidth: 1, borderRadius: 9, padding: 18, gap: 10, flexBasis: 341, flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: "100%" },
  profileHeading: { borderBottomWidth: 1, paddingBottom: 13, marginBottom: 5, gap: 3 },
  profileRole: { fontSize: 17, fontWeight: "600" },
  profileFeature: { borderRadius: 7, padding: 11 },
  legend: { fontSize: 12, fontWeight: "700" },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  choice: { borderWidth: 1, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 9 },
  choiceLabel: { fontSize: 12, fontWeight: "500" },
  selectBox: { borderWidth: 1, borderRadius: 7, overflow: "hidden" },
  selectBoxRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 10, paddingHorizontal: 11 },
  selectBoxLink: { fontSize: 12, fontWeight: "600" },
  modelList: { borderTopWidth: 1, padding: 10, gap: 6 },
});


// The communication-language card — presentation only; the shell owns the
// toggle/apply semantics and the per-target RPC.
export function LanguageCard({ colors, disabled, busy, on, value, onToggle, onChangeText, onApply }: {
  colors: Colors;
  /** Gate for the switch and apply button: no target or a write in flight. */
  disabled: boolean;
  /** A write in flight — locks the field and swaps the button label. */
  busy: boolean;
  on: boolean;
  value: string;
  onToggle(next: boolean): void;
  onChangeText(text: string): void;
  onApply(): void;
}) {
  return (
    <Card
      colors={colors}
      title="Communication language"
      subtitle="One line injected into every managed session at entry — unset keeps each model's default."
    >
      <SwitchRow
        colors={colors}
        checked={on}
        disabled={disabled}
        onToggle={onToggle}
        title="Inject communication language"
        hint="Managed seats use it for reports, handbacks and other team artifacts; direct replies to you mirror your current language."
      />
      {on ? (
        <>
          <Field
            colors={colors}
            label="Language"
            hint="As it should appear in the instruction, e.g. English"
            value={value}
            onChangeText={onChangeText}
            placeholder="English"
            disabled={busy}
          />
          <Button
            colors={colors}
            label={busy ? "Saving…" : "Apply language"}
            disabled={disabled || value.trim() === ""}
            onPress={onApply}
          />
        </>
      ) : null}
    </Card>
  );
}
