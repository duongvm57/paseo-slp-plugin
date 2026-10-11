import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CatalogRequest, CatalogResult, FamilyName, StatusResult, TargetValue } from "../shared/contracts.ts";
import type { RoleName } from "../shared/runtime/families.ts";
import { catalogScope, errorMessage } from "./manager-state.ts";
import { useTargetLifetime } from "./target-async.ts";

type Scope = { family: FamilyName | ""; role: RoleName };
type FeatureSet = { defs: CatalogResult["features"]; error: string | null };
type DisplaySnapshot = {
  catalogs: Partial<Record<string, CatalogResult>>;
  features: Record<string, FeatureSet>;
  activationId: string | null;
};
// Completed read metadata only, scoped to host/home. This survives screen
// remounts inside one plugin load; drafts, authority and pending RPCs do not.
// Bounds are memory eviction, not provider/workflow limits.
const displaySnapshots = new Map<string, DisplaySnapshot>();
function displaySnapshot(key: string | null): DisplaySnapshot {
  if (!key) return { catalogs: {}, features: {}, activationId: null };
  const existing = displaySnapshots.get(key);
  if (existing) {
    displaySnapshots.delete(key);
    displaySnapshots.set(key, existing);
    return existing;
  }
  const next: DisplaySnapshot = { catalogs: {}, features: {}, activationId: null };
  displaySnapshots.set(key, next);
  if (displaySnapshots.size > 4) displaySnapshots.delete(displaySnapshots.keys().next().value!);
  return next;
}
function remember<T>(values: Record<string, T>, key: string, value: T): Record<string, T> {
  const next = { ...values };
  delete next[key];
  next[key] = value;
  if (Object.keys(next).length > 128) delete next[Object.keys(next)[0]];
  return next;
}
const failedCatalog = (error: string): CatalogResult => ({
  schemaVersion: 1, models: [], modes: [], features: [], error,
});

/** Catalog RPC is the adapter; this module owns cache writes, demand, retry
 * and invalidation. In-flight work belongs to both a target session and a
 * cache generation, so manual retries cannot repopulate invalidated maps. */
export function useCatalogCache(target: TargetValue | null, key: string | null,
  operation: StatusResult["operation"] | undefined,
  callCatalog: (input: CatalogRequest) => Promise<CatalogResult>) {
  const capture = useTargetLifetime(key);
  const initial = useRef(displaySnapshot(key));
  const [catalogs, setCatalogs] = useState<Partial<Record<string, CatalogResult>>>(initial.current.catalogs);
  const [featureSets, setFeatureSets] = useState<Record<string, FeatureSet>>(initial.current.features);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogLoadingFor, setCatalogLoadingFor] = useState<string | null>(null);
  const [featuresLoadingFor, setFeaturesLoadingFor] = useState<string | null>(null);
  const generation = useRef({ catalogs: initial.current.catalogs,
    features: initial.current.features, requests: new Map<string, object>(),
    observed: new Set<string>(), display: initial.current });
  const refreshedActivation = useRef<string | null>(null);
  const committedKey = useRef<string | null>(null);
  const hadTarget = useRef(false);
  const invalidate = (display = displaySnapshot(key), restore = false) => {
    const catalogs = restore ? display.catalogs : {};
    const features = restore ? display.features : {};
    generation.current = { catalogs, features, requests: new Map(), observed: new Set(), display };
    setCatalogs(catalogs);
    setFeatureSets(features);
    setCatalogLoadingFor(null);
    setFeaturesLoadingFor(null);
    setCatalogRevision(current => current + 1);
  };
  useLayoutEffect(() => {
    const display = displaySnapshot(key);
    const restore = key != null && (!hadTarget.current || committedKey.current === key);
    if (key) hadTarget.current = true;
    committedKey.current = key;
    refreshedActivation.current = display.activationId;
    invalidate(display, restore);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target identity
  }, [key]);
  useLayoutEffect(() => {
    if (operation?.kind !== "activate" || !["succeeded", "no-op"].includes(operation.outcome)) return;
    if (refreshedActivation.current === operation.operationId) return;
    refreshedActivation.current = operation.operationId;
    const display: DisplaySnapshot = { catalogs: {}, features: {}, activationId: operation.operationId };
    if (key) displaySnapshots.set(key, display);
    invalidate(display);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- operation identity
  }, [key, operation]);

  const fetch = async (cacheKey: string, features: boolean, manual = false) => {
    const ticket = capture();
    if (!ticket.isCurrent()) return;
    const owner = generation.current;
    const requestKey = `${features ? "features" : "catalog"}:${cacheKey}`;
    if (!manual && owner.requests.has(requestKey)) return;
    const requestId = {};
    owner.requests.set(requestKey, requestId);
    const current = () => ticket.isCurrent() && generation.current === owner && owner.requests.get(requestKey) === requestId;
    if (!current()) return;
    const [family, role, model, modeId] = cacheKey.split("|") as [FamilyName, RoleName, string, string];
    const request: CatalogRequest = {
      schemaVersion: 1, family, role,
      ...(features ? { model, ...(modeId ? { modeId } : {}) } : {}),
      ...(target ? { cwd: target.daemonHome } : {}),
    };
    const setLoading = features ? setFeaturesLoadingFor : setCatalogLoadingFor;
    const publish = (result: CatalogResult) => {
      owner.observed.add(requestKey);
      if (features) {
        const previous = owner.features[cacheKey];
        owner.features[cacheKey] = { defs: result.error && !result.features.length && previous?.defs.length ? previous.defs : result.features, error: result.error };
        setFeatureSets({ ...owner.features });
        if (result.error === null && key && displaySnapshots.get(key) === owner.display) {
          owner.display.features = remember(owner.display.features, cacheKey, owner.features[cacheKey]);
        }
      } else {
        const previous = owner.catalogs[cacheKey];
        owner.catalogs[cacheKey] = result.error && !result.models.length && !result.modes.length && previous && (previous.models.length || previous.modes.length) ? { ...previous, error: result.error } : result;
        setCatalogs({ ...owner.catalogs });
        if (result.error === null && key && displaySnapshots.get(key) === owner.display) {
          owner.display.catalogs = remember(owner.display.catalogs as Record<string, CatalogResult>, cacheKey, result);
        }
      }
    };
    setLoading(cacheKey);
    try {
      for (let attempt = 0; attempt < (features ? 2 : 1); attempt++) {
        try {
          const result = await callCatalog(request);
          if (!current()) return;
          publish(result);
          return;
        } catch (error) {
          if (!current()) return;
          if (features && attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (!current()) return;
          } else if (features) {
            publish(failedCatalog(errorMessage(error)));
          } else {
            publish(failedCatalog(manual ? errorMessage(error) : "Catalog query failed"));
          }
        }
      }
    } finally {
      if (current()) {
        owner.requests.delete(requestKey);
        setLoading(value => value === cacheKey ? null : value);
      }
    }
  };
  const ensure = async (scopes: string[], features: string[]) => {
    const owner = generation.current;
    const ticket = capture();
    await Promise.all([
      ...scopes.map(async scope => {
        if (!ticket.isCurrent() || generation.current !== owner) return;
        const cached = owner.catalogs[scope];
        if (!owner.observed.has(`catalog:${scope}`) || cached === undefined || (cached.error !== null && cached.models.length === 0)) await fetch(scope, false);
      }),
      ...features.map(async feature => {
        if (!ticket.isCurrent() || generation.current !== owner) return;
        const cached = owner.features[feature];
        if (!owner.observed.has(`features:${feature}`) || cached === undefined || (cached.error !== null && cached.defs.length === 0)) await fetch(feature, true);
      }),
    ]);
  };
  return { catalogs, featureSets, catalogRevision, catalogLoadingFor, featuresLoadingFor,
    featureIsRefreshing: (key: string) => !generation.current.observed.has(`features:${key}`) || generation.current.requests.has(`features:${key}`),
    catalogIsRefreshing: (scope: string) => !generation.current.observed.has(`catalog:${scope}`) || generation.current.requests.has(`catalog:${scope}`),
    retryCatalog: (family: FamilyName, role: RoleName) => fetch(catalogScope(family, role), false, true),
    retryFeatureSet: (key: string) => fetch(key, true, true), ensure };
}

/** Cards declare demand after consuming the cache read view. Stable JSON
 * sets preserve commas inside models and avoid storage-key spelling in shell. */
export function useCatalogDemand(cache: ReturnType<typeof useCatalogCache>, scopes: Scope[], featureKeys: (string | null)[]) {
  const demandKey = JSON.stringify([
    [...new Set(scopes.filter(scope => scope.family !== "").map(scope => catalogScope(scope.family as FamilyName, scope.role)))].sort(),
    [...new Set(featureKeys.filter((key): key is string => key !== null && key !== ""))].sort(),
  ]);
  useEffect(() => {
    const [scopes, features] = JSON.parse(demandKey) as [string[], string[]];
    void cache.ensure(scopes, features);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cache revision and stable demand define work
  }, [demandKey, cache.catalogRevision]);
}
