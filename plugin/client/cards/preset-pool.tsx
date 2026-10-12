// The v2 view shares the existing target-bound draft/CAS controller. The v1
// editor stays available until the Human explicitly previews a conversion.
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { CatalogResult, FamilyName } from '../../shared/contracts.ts';
import { FAMILY_LABEL } from '../../shared/runtime/families.ts';
import { isAutomaticEffort } from '../../shared/runtime/peer-presets.ts';
import { catalogScope, newCustomPreset, thinkingOptionsFor } from '../manager-state.ts';
import type { PeerSeatForm } from '../manager-state.ts';
import { Badge, Button, Card, CheckRow, ChipSelect, Collapse, Field, OptionPicker, SwitchRow, styles } from '../ui-kit.tsx';
import type { Colors } from '../ui-kit.tsx';
import type { PeerPoolCardState } from './peer-pool.tsx';

export function LegacyPeerPoolNotice({ colors }: { colors: Colors }) {
  return <View style={[styles.noticeBox, { borderColor: colors.statusWarning }]}>
    <Text style={{ color: colors.foreground }}>Legacy Peer pool — upgrade recommended</Text>
    <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Your saved pool uses v1. V1 pools are deprecated; support is planned to end in a future release, with no removal release set yet. Switch to v2 presets to prepare. Your existing pool keeps running until you Save.</Text>
  </View>;
}

export function DefaultPresetControls({ colors, pool }: { colors: Colors; pool: PeerPoolCardState }) {
  return <View style={styles.field}>
    <Button colors={colors} label="Use 5 default presets" onPress={pool.requestDefaultPresets} disabled={pool.poolLocked} />
    {pool.poolDefaultsConfirm ? <View style={[styles.noticeBox, { borderColor: colors.statusWarning }]}>
      <Text style={{ color: colors.foreground }}>Replace the current draft with Fast, Balanced, Advanced, Frontier and Cross-provider?</Text>
      <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>This replaces all draft entries and clears the quota fallback. The 5 presets start disabled with no models assigned. Your pool policy stays unchanged; the saved pool changes only when you Save.</Text>
      {pool.poolData?.pool ? <Button colors={colors} label="Copy saved pool backup" onPress={() => { void pool.copyStoredPool(); }} disabled={pool.poolBusy} /> : null}
      <View style={styles.chipRow}>
        <Button colors={colors} label="Keep current draft" onPress={pool.cancelDefaultPresets} disabled={pool.poolBusy} />
        <Button colors={colors} label="Replace draft with 5 presets" onPress={pool.useDefaultPresets} disabled={pool.poolLocked} />
      </View>
    </View> : null}
  </View>;
}

export function PresetPoolCard({ colors, pool, availableFamilies, catalogs, retryCatalog, retryFeatureSet }: {
  colors: Colors; pool: PeerPoolCardState; availableFamilies: readonly FamilyName[];
  catalogs: Partial<Record<string, CatalogResult>>;
  retryCatalog(family: FamilyName, role: 'peer'): Promise<unknown>;
  retryFeatureSet(key: string): Promise<unknown>;
}) {
  const [advanced, setAdvanced] = useState<Record<string, boolean>>({});
  const disabled = pool.poolLocked;
  const migration = pool.poolData?.pool?.version === 1;
  const edit = <K extends keyof PeerSeatForm>(index: number, key: K, value: PeerSeatForm[K]) => pool.updatePool(form => ({ ...form,
    seats: form.seats.map((seat, i) => i === index ? { ...seat, [key]: value } : seat) }));
  return <Card colors={colors} title="Peer pool" subtitle="Five starter presets, or add your own. You configure models; Lead / Jev chooses a preset and supported effort for the assignment."
    trailing={<Badge colors={colors} label={pool.poolDirty ? 'Unsaved changes' : pool.poolData?.pool ? 'Saved pool' : 'Unsaved starter presets'} tone={pool.poolDirty ? 'draft' : 'neutral'} />}>
    {pool.poolReadError || pool.poolData?.error ? <Text style={{ color: colors.statusWarning }}>{pool.poolReadError ?? pool.poolData?.error}</Text> : null}
    {pool.poolData !== null && !pool.fresh ? <Text style={{ color: colors.foregroundMuted }}>Refreshing pool; previous data is read-only.</Text> : null}
    {pool.poolError ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusWarning }}>{pool.poolError.message}</Text> : null}
    {migration ? <LegacyPeerPoolNotice colors={colors} /> : null}
    {migration ? <View style={[styles.noticeBox, { borderColor: colors.statusWarning }]}>
      <Text style={{ color: colors.foreground }}>Migration preview — the saved v1 pool still runs unchanged until Save.</Text>
      <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Save verifies that the active SLP runtime can read v2; update SLP runtime first if it is still v1-only. {pool.poolDefaultsDraft ? 'The 5 defaults replace your existing entries when saved. Configure the presets you want to use.' : 'Review every description and runtime rule. Effort stays Fixed, and IDs, settings, fallback and private notes are preserved.'} Older plugin versions cannot read v2; copy the original v1 JSON before converting if you may downgrade.</Text>
      <Button colors={colors} label="Copy original v1 backup" onPress={() => { void pool.copyStoredV1(); }} disabled={pool.poolBusy} />
      <Button colors={colors} label="Cancel migration preview" onPress={pool.cancelPresetMigration} disabled={pool.poolBusy} />
    </View> : null}
    <DefaultPresetControls colors={colors} pool={pool} />
    {pool.poolDefaultsDraft ? <Text style={{ color: colors.foreground }}>5 default presets are ready to configure. Choose a provider and model, then enable the presets you want before saving.</Text> : null}
    {pool.canImportLegacy ? <Button colors={colors} label="Import legacy pool instead" onPress={pool.importLegacyPool} disabled={disabled} /> : null}
    <Field colors={colors} label="Pool policy" value={pool.poolForm.policy} onChangeText={policy => pool.updatePool(form => ({ ...form, policy }))} disabled={disabled} multiline />
    {pool.poolForm.seats.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>No presets. An empty saved pool intentionally blocks Peer formation.</Text> : null}
    {pool.poolForm.seats.map((seat, index) => {
      const catalog = seat.family ? catalogs[catalogScope(seat.family, 'peer')] : undefined;
      const thinking = thinkingOptionsFor(catalog, seat.model);
      const efforts = thinking?.options.filter(isAutomaticEffort) ?? [];
      const storedEfforts = seat.allowedEfforts?.filter(id => !efforts.some(e => e.id === id)) ?? [];
      const features = pool.featureDefsForSeat(seat);
      const toggle = () => pool.setOpenSeat(pool.openSeat === index ? null : index);
      return <Collapse key={seat.uid} colors={colors} title={seat.displayName || 'Unnamed preset'}
        subtitle={seat.enabled ? `${seat.family || 'No provider'} / ${seat.model || 'No model'}` : 'Disabled'} open={pool.openSeat === index} onToggle={toggle}>
        <Field colors={colors} label="Preset name" value={seat.displayName ?? ''} onChangeText={value => edit(index, 'displayName', value)} disabled={disabled} />
        <Field colors={colors} label="When to use" hint="Lead / Jev reads your description. Edit in any language; the preset name is not a fixed routing class."
          value={seat.description ?? ''} onChangeText={value => edit(index, 'description', value)} disabled={disabled} multiline />
        <CheckRow colors={colors} title="Enabled" checked={seat.enabled} onToggle={pool.setSeatEnabled(index)} disabled={disabled} />
        <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Provider</Text>
        <ChipSelect colors={colors} value={seat.family} options={[{ label: 'Unset', value: '' as const },
          ...availableFamilies.map(value => ({ value, label: FAMILY_LABEL[value] })),
          ...(seat.family && !availableFamilies.includes(seat.family) ? [{ value: seat.family, label: `${FAMILY_LABEL[seat.family]} (unavailable)` }] : [])]}
          onChange={pool.setSeatFamily(index)} disabled={disabled} />
        {catalog?.error ? <View style={styles.field}><Text style={{ color: colors.statusWarning }}>Catalog unavailable: {catalog.error}</Text>
          <Button colors={colors} label="Retry catalog" onPress={() => { if (seat.family) void retryCatalog(seat.family, 'peer'); }} disabled={disabled} /></View> : null}
        {catalog?.models.length ? <OptionPicker colors={colors} label="Model" options={catalog.models} value={seat.model}
          onChange={pool.setSeatField(index, 'model')} onOpen={() => { if (seat.family) void retryCatalog(seat.family, 'peer'); }} disabled={disabled} />
          : <Field colors={colors} label="Model" value={seat.model} onChangeText={pool.setSeatField(index, 'model')} disabled={disabled} />}
        <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Thinking effort</Text>
        <ChipSelect colors={colors} value={seat.effortKind ?? 'select'} options={[{ label: 'Lead / Jev chooses', value: 'select' }, { label: 'Fixed', value: 'fixed' }]}
          onChange={value => edit(index, 'effortKind', value)} disabled={disabled} />
        {seat.effortKind === 'fixed' ? thinking ? <ChipSelect colors={colors} value={seat.thinkingOptionId}
          options={[{ label: 'Provider default', value: '' }, ...thinking.options.map(e => ({ label: e.label, value: e.id })),
            ...(seat.thinkingOptionId && !thinking.options.some(e => e.id === seat.thinkingOptionId) ? [{ label: `${seat.thinkingOptionId} (stored)`, value: seat.thinkingOptionId }] : [])]}
          onChange={pool.setSeatField(index, 'thinkingOptionId')} disabled={disabled} />
          : <Field colors={colors} label="Fixed effort ID" value={seat.thinkingOptionId} onChangeText={pool.setSeatField(index, 'thinkingOptionId')} disabled={disabled} />
          : <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{thinking ? thinking.options.length ? `Automatic effort choices: ${thinking.options.filter(isAutomaticEffort).map(e => e.label).join(', ') || 'None recognized; use Fixed or resolve host metadata.'}` : 'This model has no separate effort choices; runtime default only.' : 'A fresh model catalog is required before automatic effort selection.'}</Text>}
        <Collapse colors={colors} title="Additional settings" open={advanced[seat.uid] === true} onToggle={() => setAdvanced(state => ({ ...state, [seat.uid]: !state[seat.uid] }))}>
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Provider selection</Text>
            <ChipSelect colors={colors} value={seat.runtimeRule ?? 'none'} options={[{ label: 'No restriction', value: 'none' }, { label: 'Different provider from reference', value: 'different-model-provider' }]}
              onChange={value => edit(index, 'runtimeRule', value)} disabled={disabled} />
            {seat.runtimeRule === 'different-model-provider' ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>For a second perspective: use a different provider from the agent being reviewed, such as Codex reviewing Devin. Lead / Jev names that reference agent.</Text> : null}
          </View>
          {seat.effortKind !== 'fixed' ? <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Allowed efforts</Text>
            <CheckRow colors={colors} title="All supported efforts" checked={seat.allowedEfforts === undefined}
              hint="Lead / Jev can choose any supported effort, including newly available choices."
              onToggle={all => edit(index, 'allowedEfforts', all ? undefined : efforts.map(e => e.id))}
              disabled={disabled || (seat.allowedEfforts === undefined && efforts.length === 0)} />
            <View style={styles.chipRow}>
            {efforts.map(e => <View key={e.id} style={{ minWidth: 96, flexBasis: 120, flexGrow: 1, maxWidth: 180 }}><CheckRow colors={colors} title={e.label}
              checked={seat.allowedEfforts === undefined || seat.allowedEfforts.includes(e.id)}
              onToggle={checked => {
                const selected = seat.allowedEfforts ?? efforts.map(option => option.id);
                edit(index, 'allowedEfforts', checked ? [...selected, e.id] : selected.filter(id => id !== e.id));
              }} disabled={disabled} /></View>)}
            </View>
            {storedEfforts.map(id => <CheckRow key={id} colors={colors} title={`${id} (stored, unavailable)`} checked
              hint="Kept from your saved configuration; not currently available for automatic selection. Uncheck to remove."
              onToggle={() => edit(index, 'allowedEfforts', seat.allowedEfforts?.filter(value => value !== id))} disabled={disabled} />)}
            {!thinking || catalog?.error ? <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>Choose a model and load its catalog to see supported efforts.</Text>
              : efforts.length === 0 ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{thinking.options.length === 0 ? 'This model uses runtime default only; leave All supported efforts selected.' : 'No automatic effort choices recognized. Use Fixed or resolve host metadata.'}</Text> : null}
            {seat.allowedEfforts?.length === 0 ? <Text accessibilityLiveRegion="polite" style={[styles.mutedSmall, { color: colors.statusWarning }]}>Choose at least one effort, or select All supported efforts.</Text> : null}
          </View> : null}
          <View style={[styles.field, { paddingTop: 12, borderTopWidth: 1, borderColor: colors.border }]}>
          {catalog?.modes.length ? <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Permission mode</Text>
            <ChipSelect colors={colors} value={seat.modeId} options={[{ label: 'Provider default', value: '' }, ...catalog.modes.map(m => ({ value: m.id, label: m.label })),
            ...(seat.modeId && !catalog.modes.some(m => m.id === seat.modeId) ? [{ label: `${seat.modeId} (stored)`, value: seat.modeId }] : [])]} onChange={pool.setSeatField(index, 'modeId')} disabled={disabled} />
            </View> : <Field colors={colors} label="Permission mode ID" value={seat.modeId} onChangeText={pool.setSeatField(index, 'modeId')} disabled={disabled} />}
          {features.defs.length ? features.defs.map(def => def.type === 'toggle' ? <SwitchRow key={def.id} colors={colors} title={def.label}
            checked={(seat.feature[def.id] ?? '') === '' ? def.value : seat.feature[def.id] === 'true'} onToggle={value => pool.setSeatFeature(index, def.id)(String(value))} disabled={disabled} />
            : <View key={def.id} style={styles.field}><Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>{def.label}</Text><ChipSelect colors={colors} value={seat.feature[def.id] ?? ''}
              options={[{ label: 'Provider default', value: '' }, ...def.options.map(e => ({ label: e.label, value: e.id }))]} onChange={pool.setSeatFeature(index, def.id)} disabled={disabled} /></View>)
            : <Field colors={colors} label="Feature values (JSON)" value={seat.features} onChangeText={pool.setSeatField(index, 'features')} disabled={disabled} />}
          {features.error ? <Button colors={colors} label="Retry feature controls" onPress={() => { if (features.key) void retryFeatureSet(features.key); }} disabled={disabled} /> : null}
          </View>
          <View style={[styles.field, { paddingTop: 12, borderTopWidth: 1, borderColor: colors.border }]}>
          <Field colors={colors} label="Preset ID" hint="Identifies this preset. Renaming also updates its quota fallback reference."
            value={seat.id} onChangeText={pool.setSeatId(index)} disabled={disabled} />
          <Field colors={colors} label="Selection hints" hint="Optional guidance sent to Lead / Jev. Observations about model behavior are advisory."
            value={seat.selectionHints ?? ''} onChangeText={value => edit(index, 'selectionHints', value)} disabled={disabled} multiline />
          <Field colors={colors} label="Private notes" hint="Local only; excluded from routing input." value={seat.notes} onChangeText={pool.setSeatField(index, 'notes')} disabled={disabled} multiline />
          {migration ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Original suitability: {seat.suitableFor || '(none)'}; avoid: {seat.avoidFor || '(none)'}. These original fields remain preserved for comparison.</Text> : null}
          </View>
        </Collapse>
        <View style={styles.chipRow}><Button colors={colors} label="Duplicate preset" onPress={pool.copySeatAsCustom(index)} disabled={disabled} />
          <Button colors={colors} label="Remove preset" kind="danger" onPress={pool.removeSeat(index)} disabled={disabled} /></View>
      </Collapse>;
    })}
    <Button colors={colors} label="Add preset" onPress={() => { pool.updatePool(form => ({ ...form, seats: [...form.seats, newCustomPreset(form.seats.map(s => s.id))] })); pool.setOpenSeat(pool.poolForm.seats.length); }} disabled={disabled} />
    <SwitchRow colors={colors} title="Quota fallback" hint="One designated option, one authorized attempt; runtime rules and assignment constraints still apply."
      checked={pool.poolForm.quotaFallbackEnabled} onToggle={value => pool.updatePool(form => ({ ...form, quotaFallbackEnabled: value }))} disabled={disabled} />
    <ChipSelect colors={colors} value={pool.poolForm.quotaFallbackId} options={[{ label: 'No designated fallback', value: '' }, ...pool.poolForm.seats.map(s => ({ value: s.id, label: s.displayName || s.id }))]}
      onChange={pool.setFallbackId} disabled={disabled} />
    {'error' in pool.poolBuild ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusWarning }}>{pool.poolBuild.error}</Text> : null}
    <View style={styles.chipRow}>
      <Button colors={colors} kind="primary" label={pool.poolSaving ? 'Saving…' : migration ? 'Save conversion to v2' : 'Save pool'} onPress={() => { void pool.savePeerPool(); }} disabled={disabled || !pool.poolDiffers || 'error' in pool.poolBuild} />
      <Button colors={colors} label="Copy pool JSON" onPress={() => { void pool.copyPoolJson(); }} disabled={disabled || 'error' in pool.poolBuild} />
      <Button colors={colors} label={pool.poolReloading ? 'Reloading…' : 'Reload'} onPress={() => pool.requestReload('footer')} disabled={pool.poolBusy} />
    </View>
    {pool.poolReloadConfirm ? <View style={styles.chipRow}><Button colors={colors} label="Keep current edits" onPress={() => pool.setPoolReloadConfirm(null)} />
      <Button colors={colors} label="Discard changes and Reload" onPress={() => { pool.setPoolReloadConfirm(null); void pool.reloadPeerPool(); }} /></View> : null}
    {pool.poolSaved ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusSuccess }}>Pool saved.</Text> : null}
    {pool.poolCopied ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusSuccess }}>JSON copied.</Text> : null}
  </Card>;
}
