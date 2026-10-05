import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CatalogRequest, CatalogResult, FamilyName, StatusResult, TargetValue } from "../shared/contracts.ts";
import type { RoleName } from "../shared/runtime/families.ts";
import { catalogScope, errorMessage } from "./manager-state.ts";
import { useTargetLifetime } from "./target-async.ts";

type Scope = { family: FamilyName | ""; role: RoleName };
type FeatureSet = { defs: CatalogResult["features"]; error: string | null };
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
  const [catalogs, setCatalogs] = useState<Partial<Record<string, CatalogResult>>>({});
  const [featureSets, setFeatureSets] = useState<Record<string, FeatureSet>>({});
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogLoadingFor, setCatalogLoadingFor] = useState<string | null>(null);
  const [featuresLoadingFor, setFeaturesLoadingFor] = useState<string | null>(null);
  const generation = useRef({ catalogs: {} as Partial<Record<string, CatalogResult>>,
    features: {} as Record<string, FeatureSet>, requests: new Map<string, object>() });
  const refreshedActivation = useRef<string | null>(null);
  const invalidate = () => {
    generation.current = { catalogs: {}, features: {}, requests: new Map() };
    setCatalogs({});
    setFeatureSets({});
    setCatalogLoadingFor(null);
    setFeaturesLoadingFor(null);
    setCatalogRevision(current => current + 1);
  };
  useLayoutEffect(() => {
    refreshedActivation.current = null;
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target identity
  }, [key]);
  useLayoutEffect(() => {
    if (operation?.kind !== "activate" || !["succeeded", "no-op"].includes(operation.outcome)) return;
    if (refreshedActivation.current === operation.operationId) return;
    refreshedActivation.current = operation.operationId;
    invalidate();
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
    setLoading(cacheKey);
    try {
      for (let attempt = 0; attempt < (features ? 2 : 1); attempt++) {
        try {
          const result = await callCatalog(request);
          if (!current()) return;
          if (features) {
            owner.features[cacheKey] = { defs: result.features, error: result.error };
            setFeatureSets({ ...owner.features });
          } else {
            owner.catalogs[cacheKey] = result;
            setCatalogs({ ...owner.catalogs });
          }
          return;
        } catch (error) {
          if (!current()) return;
          if (features && attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (!current()) return;
          } else if (features) {
            owner.features[cacheKey] = { defs: [], error: errorMessage(error) };
            setFeatureSets({ ...owner.features });
          } else {
            owner.catalogs[cacheKey] = failedCatalog(manual ? errorMessage(error) : "Catalog query failed");
            setCatalogs({ ...owner.catalogs });
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
      (async () => {
        for (const scope of scopes) {
          if (!ticket.isCurrent() || generation.current !== owner) return;
          // An errored observation with no usable payload does not satisfy
          // demand: cold-alias warm-up pinned transient failures as terminal
          // until a manual retry, so the next demand pass re-measures. A
          // result carrying data stays satisfied — its error is advisory.
          const cached = owner.catalogs[scope];
          if (cached === undefined || (cached.error !== null && cached.models.length === 0)) {
            await fetch(scope, false);
          }
        }
      })(),
      (async () => {
        for (const feature of features) {
          if (!ticket.isCurrent() || generation.current !== owner) return;
          const cached = owner.features[feature];
          if (cached === undefined || (cached.error !== null && cached.defs.length === 0)) {
            await fetch(feature, true);
          }
        }
      })(),
    ]);
  };
  return { catalogs, featureSets, catalogRevision, catalogLoadingFor, featuresLoadingFor,
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
