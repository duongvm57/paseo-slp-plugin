// Task history integrity. Authority is evaluated at each committed event,
// never against today's successor. This module performs no I/O or mutations.
import { DeskTaskIntegrationRecoveryPlan, DeskTaskMeasurePin, DeskTaskIntegrationControlPins, DeskTaskIntegrationCleanupTrigger,
  DeskTaskIntegrationCleanupObservation, DeskTaskIntegrationCleanupCandidate, DeskTaskIntegrationCleanupPermit,
  DeskTaskIntegrationCleanupVerification, DeskTaskIntegrationCleanupPreflightEvidence,
  type DeskTaskIntegrationCleanupObservationValue,
  type DeskTaskEntryValue, type DeskTaskDeclarationEntryValue,
  type DeskTaskActionEntryValue, type DeskTaskResourceEntryValue } from '../shared/enforcement.ts';
import type { LedgerValue, EventValue, DeskOwnerTuple } from './desk-store.ts';
import { canonicalSha256, sha256Hex } from './config-view.ts';
import { familyFromProviderId, ROLES } from '../shared/runtime/families.ts';

/** A fresh measurement retains its own timestamp in the receipt, but target
 *  identity is the complete content pin. Compare the same stable fields as
 *  cleanup admission and deliberately ignore only measuredAt. */
function measureContentPinEqual(leftValue: unknown, rightValue: unknown): boolean {
  const left = DeskTaskMeasurePin.safeParse(leftValue);
  const right = DeskTaskMeasurePin.safeParse(rightValue);
  if (!left.success || !right.success) return false;
  return left.data.root === right.data.root && left.data.head === right.data.head && left.data.kind === right.data.kind &&
    left.data.snapshotSha256 === right.data.snapshotSha256 && canonicalSha256(left.data.incomplete) === canonicalSha256(right.data.incomplete) &&
    left.data.artifactSha256 === right.data.artifactSha256;
}

/** One exact phase-edge predicate is shared by fresh runner admission and
 *  event-time history verification. It keeps replayable reconciliations
 *  narrow: an in-flight effect, a full normally observed LAND with retained
 *  admitted resources, or the already supported failed-cleanup recovery. */
export function taskIntegrationReconcileEdgeAllowed(
  previous: DeskTaskActionEntryValue,
  nextState: DeskTaskActionEntryValue['state'],
  receiptValue: unknown,
  resourceRows: readonly DeskTaskResourceEntryValue[],
): boolean {
  if (previous.actionKind !== 'integration' || typeof receiptValue !== 'object' || receiptValue === null) return false;
  const receipt = receiptValue as Record<string, unknown>;
  if (receipt.phase !== 'reconcile') return false;
  const statusToState: Record<string, DeskTaskActionEntryValue['state']> = {
    observed: 'observed', uncertain: 'uncertain', failed: 'failed', held: 'held', conflict: 'held',
  };
  if (statusToState[String(receipt.status)] !== nextState) return false;
  const hasCleanupLineage = receipt.cleanupTrigger !== undefined || receipt.cleanupObservation !== undefined;
  if (hasCleanupLineage) {
    const trigger = DeskTaskIntegrationCleanupTrigger.safeParse(receipt.cleanupTrigger);
    const observation = DeskTaskIntegrationCleanupObservation.safeParse(receipt.cleanupObservation);
    if (!trigger.success || !observation.success || trigger.data.phase !== 'reconcile' || observation.data.phase !== 'reconcile' ||
        trigger.data.cleanupStep !== observation.data.cleanupStep || receipt.status !== observation.data.status ||
        receipt.cleanupStep !== trigger.data.cleanupStep || receipt.publicRequestId !== trigger.data.publicRequestId ||
        receipt.publicRequestSha256 !== trigger.data.publicRequestSha256 || canonicalSha256(receipt.controlPins) !== canonicalSha256(trigger.data.controlPins) ||
        receipt.grantRef !== null || !sameCleanupActionShape(previous, trigger.data.cleanupStep)) return false;
    const currentRef = { entryId: previous.entryId, entrySha256: previous.entrySha256 };
    if (trigger.data.cleanupStep === 'verify-account') {
      const verifyObservation=observation.data as Extract<DeskTaskIntegrationCleanupObservationValue,{cleanupStep:'verify-account'}>;
      const candidate = DeskTaskIntegrationCleanupCandidate.safeParse(previous.body?.cleanupCandidate);
      if (!candidate.success || trigger.data.verifyIssueRef.entryId !== currentRef.entryId || trigger.data.verifyIssueRef.entrySha256 !== currentRef.entrySha256 ||
          verifyObservation.verifyIssueRef.entryId !== currentRef.entryId || verifyObservation.verifyIssueRef.entrySha256 !== currentRef.entrySha256 ||
          verifyObservation.candidateSha256 !== canonicalSha256(candidate.data) || previous.cleanupVerification != null) return false;
    } else {
      const resourceObservation=observation.data as Extract<DeskTaskIntegrationCleanupObservationValue,{cleanupStep:'remove-resource'|'reconcile-progress'}>;
      const permit = DeskTaskIntegrationCleanupPermit.safeParse(previous.body?.permit);
      const verification = DeskTaskIntegrationCleanupVerification.safeParse(previous.cleanupVerification);
      const preflight = DeskTaskIntegrationCleanupPreflightEvidence.safeParse(previous.cleanupIssueEvidence);
      if (!permit.success || !verification.success || !preflight.success ||
          trigger.data.issuedPermitRef.entryId !== currentRef.entryId || trigger.data.issuedPermitRef.entrySha256 !== currentRef.entrySha256 ||
          resourceObservation.issuedPermitRef.entryId !== currentRef.entryId || resourceObservation.issuedPermitRef.entrySha256 !== currentRef.entrySha256 ||
          canonicalSha256(trigger.data.verificationRef) !== canonicalSha256(resourceObservation.verificationRef) ||
          canonicalSha256(permit.data) !== canonicalSha256(resourceObservation.permit) ||
          canonicalSha256(preflight.data.verificationRef) !== canonicalSha256(permit.data.verificationRef) ||
          canonicalSha256(preflight.data.permit) !== canonicalSha256(permit.data)) return false;
    }
    return previous.state === 'issued';
  }
  if (['issued', 'uncertain', 'held'].includes(previous.state)) return true;

  const retainedResourcesMatchPlan = (planValue: unknown): boolean => {
    const parsed = DeskTaskIntegrationRecoveryPlan.safeParse(planValue);
    if (!parsed.success || previous.resourceIds === null || previous.resourceIds.length !== 2 ||
        new Set(previous.resourceIds).size !== 2) return false;
    const rows = previous.resourceIds.map(id => resourceRows.find(row => row.resourceId === id));
    return rows.every(row => row !== undefined && row.actionId === previous.actionId && row.disposition !== 'released') &&
      rows.some(row => row?.resourceKey === parsed.data.stageDir && row.resourceKind === (previous.stageKind === 'git-worktree' ? 'worktree' : 'scratch')) &&
      rows.some(row => row?.resourceKey === parsed.data.backupDir && row.resourceKind === 'scratch');
  };

  const samePlan = (planValue: unknown): boolean => {
    const expected = previous.recoveryPlan ?? null;
    return expected !== null && DeskTaskIntegrationRecoveryPlan.safeParse(expected).success &&
      DeskTaskIntegrationRecoveryPlan.safeParse(planValue).success &&
      canonicalSha256(expected) === canonicalSha256(planValue);
  };
  const classificationShapeMatches = (): boolean => {
    if (!samePlan(receipt.recoveryPlan)) return false;
    const classification = receipt.recoveryClassification;
    if (classification === 'full-applied') return nextState === 'observed' && receipt.backupIntegrity === true && receipt.finalMatchesExpected === true;
    if (classification === 'original') return nextState === 'observed' && receipt.backupIntegrity === true && receipt.finalMatchesExpected === false;
    if (classification === 'partial' || classification === 'unknown') return nextState === 'held' && receipt.backupIntegrity === false && receipt.finalMatchesExpected === false;
    return false;
  };

  if (previous.state === 'observed' && previous.phase === 'land' && previous.receipt?.phase === 'land' &&
      previous.receipt.status === 'observed' && previous.receipt.recoveryClassification === 'full-applied' &&
      previous.receipt.backupIntegrity === true && previous.receipt.finalMatchesExpected === true &&
      samePlan(previous.receipt.recoveryPlan) && retainedResourcesMatchPlan(previous.recoveryPlan)) {
    return classificationShapeMatches();
  }

  // Preserve the pre-existing, narrowly scoped failed-discharge recovery
  // edge. New cleanup progress uses its own typed verification/permit proof.
  return previous.state === 'failed' && previous.phase === 'discharge' && previous.receipt?.phase === 'discharge' &&
    previous.receipt.status === 'failed' && nextState !== 'failed' && classificationShapeMatches() &&
    retainedResourcesMatchPlan(previous.recoveryPlan);
}

function sameCleanupActionShape(previous: DeskTaskActionEntryValue, cleanupStep: string): boolean {
  const expected = cleanupStep === 'reconcile-progress' ? 'remove-resource' : cleanupStep;
  return previous.phase === 'discharge' && previous.body?.phase === 'discharge' && previous.body.cleanupStep === expected;
}

function unissuedCleanupVerificationContinuationAllowed(
  ledger: Readonly<LedgerValue>, row: DeskTaskActionEntryValue, previous: DeskTaskActionEntryValue, isOwner: boolean,
): boolean {
  if (!isOwner || row.actionId !== previous.actionId || row.assignmentId !== previous.assignmentId || row.taskId !== previous.taskId ||
      row.resultId !== previous.resultId || row.actionKind !== 'integration' || previous.actionKind !== 'integration' ||
      row.state !== 'intended' || row.phase !== 'discharge' || previous.state !== 'intended' || previous.phase !== 'discharge' ||
      row.receipt !== null || previous.receipt !== null || row.body?.phase !== 'discharge' || previous.body?.phase !== 'discharge' ||
      row.body.cleanupStep !== 'verify-account' || previous.body.cleanupStep !== 'verify-account' ||
      row.body.publicRequestId === previous.body.publicRequestId) return false;
  const priorIntents = ledger.taskEntries.filter((entry): entry is DeskTaskActionEntryValue => entry.kind === 'action' && entry.actionId === row.actionId &&
    entry.phase === 'discharge' && entry.state === 'intended' && entry.body?.cleanupStep === 'verify-account' && entry.revision < row.revision);
  if (priorIntents.length !== 1) return false;
  const before = DeskTaskIntegrationCleanupCandidate.safeParse(previous.body.cleanupCandidate);
  const after = DeskTaskIntegrationCleanupCandidate.safeParse(row.body.cleanupCandidate);
  return before.success && after.success && canonicalSha256(before.data) === canonicalSha256(after.data) &&
    canonicalSha256(previous.recoveryPlan ?? null) === canonicalSha256(row.recoveryPlan ?? null) &&
    canonicalSha256(previous.grant ?? null) === canonicalSha256(row.grant ?? null);
}

export function taskGraphValid(rows: readonly DeskTaskEntryValue[]): boolean {
  const tasks = new Map<string, DeskTaskDeclarationEntryValue>();
  for (const row of rows) if (row.kind === 'task') tasks.set(row.taskId, row);
  const active = new Set<string>(), done = new Set<string>();
  function visit(id: string): boolean {
    if (active.has(id)) return false;
    if (done.has(id)) return true;
    const task = tasks.get(id); if (!task) return false;
    active.add(id);
    const ids = new Set<string>();
    for (const dep of task.dependencies) {
      const producer = tasks.get(dep.taskId);
      if (!producer || producer.assignmentId !== task.assignmentId || ids.has(dep.taskId) || !visit(dep.taskId)) return false;
      if (dep.availability === 'artifact' && dep.artifactKey === null) return false;
      ids.add(dep.taskId);
    }
    active.delete(id); done.add(id); return true;
  }
  return [...tasks.keys()].every(visit);
}

function cleanupReceiptHistoryValid(
  ledger: Readonly<LedgerValue>, row: DeskTaskActionEntryValue, previous: DeskTaskActionEntryValue,
  heads: ReadonlyMap<string, DeskTaskEntryValue>, receipt: Record<string, unknown>, isOwner: boolean,
): boolean {
  const trigger = DeskTaskIntegrationCleanupTrigger.safeParse(receipt.cleanupTrigger);
  const observation = DeskTaskIntegrationCleanupObservation.safeParse(receipt.cleanupObservation);
  if (!trigger.success || !observation.success || row.actionKind !== 'integration' || !isOwner || previous.state !== 'issued' ||
      previous.phase !== 'discharge' || previous.body?.phase !== 'discharge' || receipt.phase !== trigger.data.phase ||
      receipt.cleanupStep !== trigger.data.cleanupStep || receipt.status !== observation.data.status ||
      observation.data.phase !== trigger.data.phase || observation.data.cleanupStep !== trigger.data.cleanupStep ||
      canonicalSha256(receipt.controlPins) !== canonicalSha256(trigger.data.controlPins) ||
      canonicalSha256(receipt.recoveryPlan ?? null) !== canonicalSha256(row.recoveryPlan ?? null) ||
      receipt.publicRequestId !== trigger.data.publicRequestId || receipt.publicRequestSha256 !== trigger.data.publicRequestSha256 ||
      receipt.grantRef !== (trigger.data.phase === 'discharge' ? row.grant?.authorityRef ?? null : null)) return false;
  const expectedBodyStep = trigger.data.cleanupStep === 'reconcile-progress' ? 'remove-resource' : trigger.data.cleanupStep;
  if (previous.body.cleanupStep !== expectedBodyStep || row.state !== (observation.data.status === 'observed' ? 'observed' : 'held')) return false;
  const request = ledger.requests.find(item => item.actorKey === `agent:${row.actorAgentId}` && item.assignmentId === row.assignmentId && item.requestId === row.requestId);
  if (trigger.data.phase === 'discharge') {
    if (canonicalSha256(previous.body.controlPins ?? null) !== canonicalSha256(trigger.data.controlPins) ||
        previous.body.publicRequestId !== trigger.data.publicRequestId || previous.body.publicRequestSha256 !== trigger.data.publicRequestSha256 ||
        previous.body.grantRef !== row.grant?.authorityRef) return false;
  } else {
    const pins = trigger.data.controlPins;
    const result = getHead(heads, row.resultId, 'result');
    const adjudication = result?.kind === 'result' ? [...heads.values()].filter(item => item.kind === 'adjudication' && item.resultId === result.resultId)
      .sort((a, b) => b.revision - a.revision)[0] : undefined;
    if (request === undefined || pins.assignmentId !== row.assignmentId || pins.taskId !== row.taskId || pins.resultId !== row.resultId ||
        pins.expectedActionRevision !== previous.revision || pins.expectedLedgerRevision !== request.revision - 1 ||
        result?.kind !== 'result' || result.revision !== pins.expectedResultRevision || adjudication?.kind !== 'adjudication' ||
        adjudication.revision !== pins.expectedAdjudicationRevision) return false;
  }
  const currentRef = { entryId: previous.entryId, entrySha256: previous.entrySha256 };
  if (trigger.data.cleanupStep === 'verify-account') {
    const verifyObservation = observation.data as Extract<DeskTaskIntegrationCleanupObservationValue, { cleanupStep: 'verify-account' }>;
    const candidate = DeskTaskIntegrationCleanupCandidate.safeParse(previous.body.cleanupCandidate);
    if (!candidate.success || canonicalSha256(trigger.data.verifyIssueRef) !== canonicalSha256(currentRef) ||
        canonicalSha256(verifyObservation.verifyIssueRef) !== canonicalSha256(currentRef) ||
        verifyObservation.candidateSha256 !== canonicalSha256(candidate.data) ||
        canonicalSha256(verifyObservation.artifact) !== canonicalSha256(candidate.data.artifact) ||
        canonicalSha256(verifyObservation.sourceProofRef) !== canonicalSha256(candidate.data.sourceProofRef) ||
        verifyObservation.target === null || !measureContentPinEqual(verifyObservation.target, candidate.data.targetBefore) ||
        verifyObservation.resources.length !== candidate.data.resources.length) return false;
    for (let index = 0; index < candidate.data.resources.length; index += 1) {
      const pin = candidate.data.resources[index]!;
      const summary = verifyObservation.resources[index]!;
      const resource = getHead(heads, pin.resourceId, 'resource');
      if (resource?.kind !== 'resource' || resource.disposition !== 'retained' || summary.resourceId !== pin.resourceId ||
          summary.resourceRevision !== resource.revision || summary.resourceKey !== pin.resourceKey ||
          summary.expectedInventoryMapSha256 !== pin.inventoryMapSha256 || summary.observedInventoryMapSha256 !== pin.inventoryMapSha256 ||
          summary.expectedEntryCount !== pin.entryCount || summary.observedEntryCount !== pin.entryCount || summary.missingPathCount !== 0 ||
          summary.missingPathsSha256 !== null || summary.survivorMapSha256 !== pin.inventoryMapSha256 ||
          summary.survivorEntryCount !== pin.entryCount || summary.rootMode !== pin.rootMode ||
          summary.gitRegistration !== (pin.resourceKind === 'worktree' ? 'matched' : 'not-applicable')) return false;
    }
    if (verifyObservation.status === 'observed') {
      const expectedVerification = { candidate: candidate.data, verifyIssueRef: currentRef,
        observerResponseSha256: verifyObservation.observerResponseSha256 };
      if (canonicalSha256(row.cleanupVerification) !== canonicalSha256(expectedVerification)) return false;
    } else if (row.cleanupVerification != null || previous.cleanupVerification != null) return false;
    return true;
  }
  const resourceObservation = observation.data as Extract<DeskTaskIntegrationCleanupObservationValue, { cleanupStep: 'remove-resource' | 'reconcile-progress' }>;
  const permit = DeskTaskIntegrationCleanupPermit.safeParse(previous.body.permit);
  const verification = DeskTaskIntegrationCleanupVerification.safeParse(previous.cleanupVerification);
  const preflight = DeskTaskIntegrationCleanupPreflightEvidence.safeParse(previous.cleanupIssueEvidence);
  if (!permit.success || !verification.success || !preflight.success ||
      canonicalSha256(trigger.data.issuedPermitRef) !== canonicalSha256(currentRef) ||
      canonicalSha256(resourceObservation.issuedPermitRef) !== canonicalSha256(currentRef) ||
      canonicalSha256(trigger.data.verificationRef) !== canonicalSha256(permit.data.verificationRef) ||
      canonicalSha256(resourceObservation.verificationRef) !== canonicalSha256(permit.data.verificationRef) ||
      canonicalSha256(resourceObservation.permit) !== canonicalSha256(permit.data) ||
      canonicalSha256(preflight.data.permit) !== canonicalSha256(permit.data) ||
      canonicalSha256(preflight.data.verificationRef) !== canonicalSha256(permit.data.verificationRef) ||
      resourceObservation.target === null || !measureContentPinEqual(resourceObservation.target, verification.data.candidate.targetBefore) ||
      resourceObservation.resources.length !== verification.data.candidate.resources.length) return false;
  const target = resourceObservation.resources.find(item => item.resourceId === permit.data.resourceId);
  if (target === undefined || target.resourceKey !== permit.data.resourceKey || target.expectedInventoryMapSha256 !== permit.data.inventoryMapSha256 ||
      target.expectedEntryCount <= 0 || target.missingPathCount < 0 || target.missingPathCount > target.expectedEntryCount ||
      (resourceObservation.status === 'observed' && (target.missingPathCount !== target.expectedEntryCount || target.survivorEntryCount !== 0)) ||
      (resourceObservation.status === 'held' && target.missingPathCount === target.expectedEntryCount && target.survivorEntryCount === 0)) return false;
  for (const summary of resourceObservation.resources) {
    const resource = getHead(heads, summary.resourceId, 'resource');
    const pin = verification.data.candidate.resources.find(item => item.resourceId === summary.resourceId);
    if (resource?.kind !== 'resource' || pin === undefined || summary.resourceRevision !== resource.revision ||
        summary.resourceKey !== resource.resourceKey || summary.expectedInventoryMapSha256 !== pin.inventoryMapSha256 ||
        summary.expectedEntryCount !== pin.entryCount || summary.survivorEntryCount + summary.missingPathCount !== pin.entryCount ||
        (resource.disposition === 'released' && summary.missingPathCount !== pin.entryCount) ||
        (resource.disposition !== 'released' && resource.resourceId !== permit.data.resourceId && summary.missingPathCount !== 0) ||
        (summary.missingPathCount === 0 && (summary.observedInventoryMapSha256 !== pin.inventoryMapSha256 ||
          summary.survivorMapSha256 !== pin.inventoryMapSha256 || summary.survivorEntryCount !== pin.entryCount || summary.missingPathsSha256 !== null)) ||
        (summary.missingPathCount > 0 && summary.missingPathsSha256 === null)) return false;
  }
  return true;
}

function cleanupContinuationIntentAllowed(
  ledger: Readonly<LedgerValue>, row: DeskTaskActionEntryValue, previous: DeskTaskActionEntryValue,
  heads: ReadonlyMap<string, DeskTaskEntryValue>, isOwner: boolean,
): boolean {
  const body = row.body;
  const receipt = previous.receipt as Record<string, unknown> | null;
  const observation = DeskTaskIntegrationCleanupObservation.safeParse(receipt?.cleanupObservation);
  if (!isOwner || body === null || row.state !== 'intended' || row.phase !== 'discharge' || body.phase !== 'discharge' ||
      observation.success === false || body.grantRef !== previous.grant?.authorityRef ||
      canonicalSha256(body.recoveryPlan ?? null) !== canonicalSha256(previous.recoveryPlan ?? null)) return false;
  const pins = body.controlPins as Record<string, unknown> | undefined;
  const request = ledger.requests.find(item => item.actorKey === `agent:${row.actorAgentId}` && item.assignmentId === row.assignmentId && item.requestId === row.requestId);
  const result = getHead(heads, row.resultId, 'result');
  const adjudication = result?.kind === 'result' ? [...heads.values()].filter(item => item.kind === 'adjudication' && item.resultId === result.resultId)
    .sort((a, b) => b.revision - a.revision)[0] : undefined;
  if (pins === undefined || request === undefined || pins.assignmentId !== row.assignmentId || pins.taskId !== row.taskId || pins.resultId !== row.resultId ||
      pins.expectedActionRevision !== previous.revision || pins.expectedLedgerRevision !== request.revision - 1 ||
      result?.kind !== 'result' || result.revision !== pins.expectedResultRevision || adjudication?.kind !== 'adjudication' ||
      adjudication.revision !== pins.expectedAdjudicationRevision || typeof body.publicRequestId !== 'string' ||
      typeof body.publicRequestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.publicRequestSha256)) return false;
  const candidate = DeskTaskIntegrationCleanupVerification.safeParse(previous.cleanupVerification);
  const previousStep = observation.data.cleanupStep;
  if (previousStep === 'verify-account') {
    const previousCandidate = DeskTaskIntegrationCleanupCandidate.safeParse(previous.body?.cleanupCandidate);
    if (observation.data.status === 'held') {
      const nextCandidate = DeskTaskIntegrationCleanupCandidate.safeParse(body.cleanupCandidate);
      const priorCycles = ledger.taskEntries.filter(item => item.kind === 'action' && item.actionId === row.actionId && item.revision < row.revision &&
        item.state === 'intended' && item.phase === 'discharge' && item.body?.cleanupStep === 'verify-account').length;
      return body.cleanupStep === 'verify-account' && previousCandidate.success && nextCandidate.success &&
        canonicalSha256(previousCandidate.data) === canonicalSha256(nextCandidate.data) && priorCycles === 1 &&
        !DeskTaskIntegrationCleanupVerification.safeParse(previous.cleanupVerification).success;
    }
    if (observation.data.status !== 'observed' || !candidate.success || !previousCandidate.success ||
        canonicalSha256(candidate.data.candidate) !== canonicalSha256(previousCandidate.data) || body.cleanupStep !== 'remove-resource') return false;
  } else {
    const previousPermit = DeskTaskIntegrationCleanupPermit.safeParse(previous.body?.permit);
    const nextPermit = DeskTaskIntegrationCleanupPermit.safeParse(body.permit);
    const verificationRef = ledger.taskEntries.filter(item => item.kind === 'action' && item.actionId === row.actionId && item.cleanupVerification != null)
      .sort((a, b) => a.revision - b.revision)[0];
    if (!previousPermit.success || !nextPermit.success || !candidate.success || verificationRef?.kind !== 'action' || body.cleanupStep !== 'remove-resource' ||
        canonicalSha256(body.verificationRef) !== canonicalSha256({ entryId: verificationRef.entryId, entrySha256: verificationRef.entrySha256 })) return false;
    const next = nextPermit.data;
    const currentTarget = getHead(heads, next.resourceId, 'resource');
    if (currentTarget?.kind !== 'resource' || currentTarget.disposition !== 'retained' || currentTarget.revision !== next.expectedResourceRevision ||
        currentTarget.resourceKey !== next.resourceKey) return false;
    if (observation.data.status === 'held') {
      const cycles = ledger.taskEntries.filter(item => item.kind === 'action' && item.actionId === row.actionId && item.revision < row.revision &&
        item.state === 'intended' && item.phase === 'discharge' && item.body?.cleanupStep === 'remove-resource' &&
        (item.body.permit as Record<string, unknown> | undefined)?.resourceId === next.resourceId).length;
      return next.resourceId === previousPermit.data.resourceId && next.ordinal === previousPermit.data.ordinal + 1 && cycles === previousPermit.data.ordinal &&
        canonicalSha256(next.verificationRef) === canonicalSha256(previousPermit.data.verificationRef) &&
        next.inventoryMapSha256 === previousPermit.data.inventoryMapSha256 && next.cleanupRecipe === previousPermit.data.cleanupRecipe;
    }
    if (observation.data.status !== 'observed' || currentTarget.resourceId === previousPermit.data.resourceId) return false;
    const firstRetained = candidate.data.candidate.resources.find(pin => {
      const resource = getHead(heads, pin.resourceId, 'resource');
      return resource?.kind === 'resource' && resource.disposition === 'retained';
    });
    if (firstRetained === undefined || firstRetained.resourceId !== next.resourceId || next.ordinal !== 1 ||
        next.resourceKey !== firstRetained.resourceKey || next.inventoryMapSha256 !== firstRetained.inventoryMapSha256) return false;
  }
  const nextPermit = DeskTaskIntegrationCleanupPermit.safeParse(body.permit);
  if (!nextPermit.success || !candidate.success) return false;
  const firstRetained = candidate.data.candidate.resources.find(pin => {
    const resource = getHead(heads, pin.resourceId, 'resource');
    return resource?.kind === 'resource' && resource.disposition === 'retained';
  });
  return firstRetained !== undefined && firstRetained.resourceId === nextPermit.data.resourceId && nextPermit.data.ordinal === 1 &&
    nextPermit.data.expectedResourceRevision === getHead(heads, firstRetained.resourceId, 'resource')?.revision &&
    nextPermit.data.resourceKey === firstRetained.resourceKey && nextPermit.data.inventoryMapSha256 === firstRetained.inventoryMapSha256;
}

/** A resource ISSUE carries the current readonly preflight on that exact
 *  issued revision. The preceding intent may have copied evidence from an
 *  earlier cycle, but a fresh intent clears it; this validator binds the new
 *  digest and resource summaries to the current permit, owner/CAS, account,
 *  and any earlier issued permit that can explain missing paths. */
function cleanupIssuePreflightHistoryValid(
  ledger: Readonly<LedgerValue>, row: DeskTaskActionEntryValue, previous: DeskTaskActionEntryValue,
  heads: ReadonlyMap<string, DeskTaskEntryValue>, isOwner: boolean,
): boolean {
  const body = row.body;
  const evidence = DeskTaskIntegrationCleanupPreflightEvidence.safeParse(row.cleanupIssueEvidence);
  const permit = DeskTaskIntegrationCleanupPermit.safeParse(body?.permit);
  const verification = DeskTaskIntegrationCleanupVerification.safeParse(row.cleanupVerification);
  const controlPins = DeskTaskIntegrationControlPins.safeParse(body?.controlPins);
  const intentRequest = ledger.requests.find(item => item.actorKey === `agent:${previous.actorAgentId}` &&
    item.assignmentId === previous.assignmentId && item.requestId === previous.requestId);
  const priorAction = previous.priorEntryId === null ? undefined : ledger.taskEntries.find(item => item.entryId === previous.priorEntryId);
  const result = getHead(heads, row.resultId, 'result');
  const adjudication = result?.kind === 'result' ? [...heads.values()].filter(item => item.kind === 'adjudication' && item.resultId === result.resultId)
    .sort((a, b) => b.revision - a.revision)[0] : undefined;
  if (!isOwner || !evidence.success || !permit.success || !verification.success || !controlPins.success || intentRequest === undefined ||
      priorAction?.kind !== 'action' || result?.kind !== 'result' || adjudication?.kind !== 'adjudication' ||
      previous.actionKind !== 'integration' || previous.phase !== 'discharge' || previous.state !== 'intended' ||
      previous.body?.phase !== 'discharge' || previous.body.cleanupStep !== 'remove-resource' ||
      row.actionKind !== 'integration' || row.phase !== 'discharge' || row.state !== 'issued' ||
      body?.phase !== 'discharge' || body.cleanupStep !== 'remove-resource' || previous.bodySha256 !== row.bodySha256 ||
      canonicalSha256(previous.body) !== canonicalSha256(body) || canonicalSha256(previous.recoveryPlan ?? null) !== canonicalSha256(row.recoveryPlan ?? null) ||
      canonicalSha256(previous.cleanupVerification ?? null) !== canonicalSha256(row.cleanupVerification ?? null) ||
      canonicalSha256(previous.grant ?? null) !== canonicalSha256(row.grant ?? null) || row.grant?.authorityRef == null ||
      controlPins.data.assignmentId !== row.assignmentId || controlPins.data.taskId !== row.taskId || controlPins.data.resultId !== row.resultId ||
      controlPins.data.expectedActionRevision !== priorAction.revision || controlPins.data.expectedLedgerRevision !== intentRequest.revision - 1 ||
      controlPins.data.expectedResultRevision !== result.revision || controlPins.data.expectedAdjudicationRevision !== adjudication.revision) return false;

  const currentRef = { entryId: previous.entryId, entrySha256: previous.entrySha256 };
  const admission = {
    phase: 'discharge' as const,
    publicRequestId: body.publicRequestId,
    publicRequestSha256: body.publicRequestSha256,
    grantRef: row.grant.authorityRef,
    controlPins: controlPins.data,
    intentRef: currentRef,
    issueRef: null,
  };
  if (typeof body.publicRequestId !== 'string' || typeof body.publicRequestSha256 !== 'string' ||
      evidence.data.admissionSha256 !== canonicalSha256({ domain: 'paseo-slp/task-integration-cleanup-public-admission/v1', admission }) ||
      canonicalSha256(evidence.data.permit) !== canonicalSha256(permit.data) ||
      canonicalSha256(evidence.data.verificationRef) !== canonicalSha256(permit.data.verificationRef) ||
      evidence.data.target === null || !measureContentPinEqual(evidence.data.target, verification.data.candidate.targetBefore)) return false;

  const verificationEntry = ledger.taskEntries.filter((entry): entry is DeskTaskActionEntryValue => entry.kind === 'action' &&
    entry.actionId === row.actionId && entry.revision < row.revision && entry.cleanupVerification != null)
    .sort((a, b) => a.revision - b.revision)[0];
  if (verificationEntry === undefined || canonicalSha256(permit.data.verificationRef) !== canonicalSha256({
    entryId: verificationEntry.entryId, entrySha256: verificationEntry.entrySha256,
  }) || permit.data.actionId !== row.actionId) return false;

  const candidate = verification.data.candidate;
  const pin = candidate.resources.find(item => item.resourceId === permit.data.resourceId);
  const target = getHead(heads, permit.data.resourceId, 'resource');
  const priorIssued = ledger.taskEntries.filter((entry): entry is DeskTaskActionEntryValue => entry.kind === 'action' &&
    entry.actionId === row.actionId && entry.phase === 'discharge' && entry.state === 'issued' &&
    entry.revision < row.revision && entry.body?.cleanupStep === 'remove-resource' &&
    DeskTaskIntegrationCleanupPermit.safeParse(entry.body.permit).success &&
    (entry.body.permit as { resourceId?: unknown }).resourceId === permit.data.resourceId)
    .sort((a, b) => b.revision - a.revision)[0];
  const priorPermit = priorIssued === undefined ? null : DeskTaskIntegrationCleanupPermit.safeParse(priorIssued.body?.permit);
  const priorRef = priorIssued === undefined ? null : { entryId: priorIssued.entryId, entrySha256: priorIssued.entrySha256 };
  if (pin === undefined || target?.kind !== 'resource' || target.disposition !== 'retained' || target.revision !== permit.data.expectedResourceRevision ||
      target.resourceKey !== permit.data.resourceKey || pin.resourceRevision !== target.revision || pin.resourceKey !== target.resourceKey ||
      pin.inventoryMapSha256 !== permit.data.inventoryMapSha256 || pin.cleanupRecipe !== permit.data.cleanupRecipe ||
      canonicalSha256(evidence.data.priorIssuedPermitRef) !== canonicalSha256(priorRef) ||
      (permit.data.ordinal === 1 && priorIssued !== undefined) ||
      (permit.data.ordinal === 2 && (priorIssued === undefined || priorPermit?.success !== true || priorPermit.data.ordinal !== 1)) ||
      (permit.data.ordinal === 2 && priorPermit?.success === true &&
        (priorPermit.data.actionId !== permit.data.actionId || priorPermit.data.resourceKey !== permit.data.resourceKey ||
         priorPermit.data.inventoryMapSha256 !== permit.data.inventoryMapSha256 || priorPermit.data.cleanupRecipe !== permit.data.cleanupRecipe))) return false;

  if (evidence.data.resources.length !== candidate.resources.length) return false;
  for (let index = 0; index < candidate.resources.length; index += 1) {
    const resourcePin = candidate.resources[index]!;
    const summary = evidence.data.resources[index]!;
    const current = getHead(heads, resourcePin.resourceId, 'resource');
    if (current?.kind !== 'resource' || current.actionId !== row.actionId || summary.resourceId !== resourcePin.resourceId ||
        summary.resourceRevision !== current.revision || summary.resourceKey !== current.resourceKey || summary.resourceKey !== resourcePin.resourceKey ||
        summary.expectedInventoryMapSha256 !== resourcePin.inventoryMapSha256 || summary.expectedEntryCount !== resourcePin.entryCount ||
        summary.observedEntryCount !== summary.survivorEntryCount || summary.survivorEntryCount + summary.missingPathCount !== resourcePin.entryCount ||
        summary.missingPathCount > 0 && summary.missingPathsSha256 === null ||
        summary.rootMode !== (summary.survivorEntryCount === 0 ? null : resourcePin.rootMode)) return false;
    const missingAllowed = current.disposition === 'released' ||
      (current.resourceId === permit.data.resourceId && priorIssued !== undefined && priorPermit?.success === true && priorPermit.data.ordinal < permit.data.ordinal);
    if ((current.disposition === 'released' && (summary.missingPathCount !== resourcePin.entryCount || summary.survivorEntryCount !== 0)) ||
        (current.disposition !== 'released' && current.resourceId !== permit.data.resourceId && summary.missingPathCount !== 0) ||
        (current.resourceId === permit.data.resourceId && summary.missingPathCount > 0 && !missingAllowed) ||
        (current.resourceId === permit.data.resourceId && summary.missingPathCount === resourcePin.entryCount)) return false;
    if (summary.missingPathCount === 0 && (summary.observedInventoryMapSha256 !== resourcePin.inventoryMapSha256 ||
        summary.survivorMapSha256 !== resourcePin.inventoryMapSha256 || summary.missingPathsSha256 !== null)) return false;
    if (summary.missingPathCount > 0 && (summary.observedInventoryMapSha256 !== summary.survivorMapSha256 ||
        summary.survivorEntryCount === 0 && summary.survivorMapSha256 !== null)) return false;
    if ((resourcePin.resourceKind === 'worktree' && summary.gitRegistration !== (summary.missingPathCount === resourcePin.entryCount ? 'missing' : 'matched')) ||
        (resourcePin.resourceKind === 'scratch' && summary.gitRegistration !== 'not-applicable')) return false;
  }
  if (pin.role === 'backup') {
    const stage = candidate.resources.find(item => item.role === 'stage');
    const stageHead = stage === undefined ? undefined : getHead(heads, stage.resourceId, 'resource');
    if (stage === undefined || stageHead?.kind !== 'resource' || stageHead.disposition !== 'released') return false;
  }
  return true;
}

function getHead(ledgerHeads: ReadonlyMap<string, DeskTaskEntryValue>, id: string | null, kind: DeskTaskEntryValue['kind']): DeskTaskEntryValue | undefined {
  const row = id === null ? undefined : ledgerHeads.get(id);
  return row?.kind === kind ? row : undefined;
}

export function taskHistoryValid(
  ledger: Readonly<LedgerValue>, events: readonly EventValue[],
  ownerAt: (assignmentId: string, seq: number) => DeskOwnerTuple,
  briefAt: (assignmentId: string, seq: number) => number,
): boolean {
  const byEntry = new Map(ledger.taskEntries.map(row => [row.entryId, row]));
  const heads = new Map<string, DeskTaskEntryValue>();
  const entryEvents = events.filter(event => event.kind === 'task-entry-appended');
  const taskEntryEventById = new Map<string, EventValue>();
  const registrationSeqByMembership = new Map<string, { seq: number; agentId: string }[]>();
  const revocationSeqByMembership = new Map<string, { seq: number; reason: unknown }>();
  for (const event of events) {
    if (event.kind !== 'seat-registered' && event.kind !== 'seat-revoked') continue;
    const membershipId = typeof event.payload.membershipId === 'string' ? event.payload.membershipId : null;
    if (membershipId === null) return false;
    if (event.kind === 'seat-registered') {
      const agentId = typeof event.payload.agentId === 'string' ? event.payload.agentId : null;
      if (agentId === null) return false;
      const rows = registrationSeqByMembership.get(membershipId) ?? [];
      rows.push({ seq: event.seq, agentId });
      registrationSeqByMembership.set(membershipId, rows);
    } else {
      if (revocationSeqByMembership.has(membershipId)) return false;
      revocationSeqByMembership.set(membershipId, { seq: event.seq, reason: event.payload.reason });
    }
  }
  if (entryEvents.length !== byEntry.size) return false;
  const members = new Map(ledger.memberships.map(row => [row.membershipId, row]));
  const get = (id: string | null | undefined, kind?: DeskTaskEntryValue['kind']) => {
    const row = id == null ? undefined : heads.get(id);
    return row && (!kind || row.kind === kind) ? row : undefined;
  };
  for (const event of entryEvents) {
    const row = typeof event.payload.entryId === 'string' ? byEntry.get(event.payload.entryId) : undefined;
    if (!row || event.assignmentId !== row.assignmentId || event.payload.taskId !== row.taskId ||
        event.payload.entityId !== row.entityId || event.payload.entryKind !== row.kind || event.payload.revision !== row.revision ||
        event.payload.entrySha256 !== row.entrySha256 || event.payload.actorMembershipId !== row.actorMembershipId ||
        event.payload.briefRevision !== row.briefRevision || event.payload.ownershipRevision !== row.ownershipRevision ||
        event.actorKey !== `agent:${row.actorAgentId}` || event.requestId !== row.requestId) return false;
    taskEntryEventById.set(row.entryId, event);
    const member = members.get(row.actorMembershipId);
    const registrations = registrationSeqByMembership.get(row.actorMembershipId);
    const revoked = revocationSeqByMembership.get(row.actorMembershipId);
    if (!member || member.agentId !== row.actorAgentId || member.registeredAt === null ||
        (registrations === undefined ? member.registeredAt > event.at :
          !registrations.some(registration => registration.seq < event.seq && registration.agentId === row.actorAgentId)) ||
        (revoked !== undefined && (member.revokedAt === null || member.revokeReason !== revoked.reason || revoked.seq < event.seq)) ||
        (revoked === undefined && member.revokedAt !== null && member.revokedAt <= event.at)) return false;
    const owner = ownerAt(row.assignmentId, event.seq);
    const isOwner = owner.agentId === row.actorAgentId && owner.membershipId === row.actorMembershipId && member.role === 'lead';
    const ownershipRevision = events.filter(prior => prior.seq < event.seq && prior.assignmentId === row.assignmentId && prior.kind === 'ownership-accepted').length;
    if (row.briefRevision !== briefAt(row.assignmentId, event.seq) || row.ownershipRevision !== ownershipRevision) return false;
    const previous = get(row.entityId);
    if (previous && (previous.kind !== row.kind || previous.assignmentId !== row.assignmentId || previous.taskId !== row.taskId)) return false;
    if (row.revision !== (previous?.revision ?? 0) + 1 || row.priorEntryId !== (previous?.entryId ?? null) || row.priorEntrySha256 !== (previous?.entrySha256 ?? null)) return false;
    const task = row.kind === 'task' ? row : get(row.taskId, 'task');
    if (row.taskId !== null && (!task || task.assignmentId !== row.assignmentId)) return false;
    if (row.taskId === null && !['delivery','resource','control'].includes(row.kind)) return false;
    const attemptId = 'attemptId' in row ? row.attemptId : null;
    const attempt = get(attemptId, 'attempt');
    const isWorker = attempt?.kind === 'attempt' && attempt.member !== null && attempt.member.agentId === row.actorAgentId && attempt.member.membershipId === row.actorMembershipId;
    if (!isOwner) {
      const recipient = row.kind === 'delivery' && previous?.kind === 'delivery' && previous.recipientAgentId === row.actorAgentId && previous.recipientMembershipId === row.actorMembershipId;
      const workerObservation = row.kind === 'action' && previous?.kind === 'action' && isWorker && ['issued','uncertain','held'].includes(previous.state) && row.state !== 'issued' && row.state !== 'intended';
      const workerResult = row.kind === 'result' && isWorker;
      const workerHandback = row.kind === 'delivery' && previous === undefined && row.deliveryKind === 'handback' && isWorker && row.senderMembershipId === row.actorMembershipId && row.recipientMembershipId === owner.membershipId;
      const workerHold = row.kind === 'hold' && previous === undefined && row.state === 'open' && isWorker;
      const workerAttempt = row.kind === 'attempt' && previous?.kind === 'attempt' && previous.member?.membershipId === row.actorMembershipId &&
        ledger.taskEntries.some(other => other.requestId === row.requestId && other.actorMembershipId === row.actorMembershipId && other.assignmentId === row.assignmentId &&
          ((other.kind === 'result' && other.attemptId === row.attemptId) || (other.kind === 'action' && other.attemptId === row.attemptId)));
      if (!recipient && !workerObservation && !workerResult && !workerHandback && !workerHold && !workerAttempt) return false;
    }
    if (row.kind==='resource' || row.kind==='delivery') {
      if(row.attemptId!==null && (attempt?.kind!=='attempt' || attempt.assignmentId!==row.assignmentId || (row.taskId!==null && row.taskId!==attempt.taskId)))return false;
      if(row.actionId!==null){const action=get(row.actionId,'action');if(action?.kind!=='action' || action.assignmentId!==row.assignmentId || (row.attemptId!==null && action.attemptId!==row.attemptId))return false;}
      if(row.kind==='delivery' && row.resultId!==null){const result=get(row.resultId,'result');if(result?.kind!=='result' || result.assignmentId!==row.assignmentId || (row.attemptId!==null && result.attemptId!==row.attemptId))return false;}
    }
    if(row.kind==='control'){
      if(row.targetTaskId!==null && get(row.targetTaskId,'task')?.assignmentId!==row.assignmentId)return false;
      if(row.targetAttemptId!==null && get(row.targetAttemptId,'attempt')?.assignmentId!==row.assignmentId)return false;
      if(row.outstandingActionIds.some(id=>get(id,'action')?.assignmentId!==row.assignmentId) || row.outstandingResourceIds.some(id=>get(id,'resource')?.assignmentId!==row.assignmentId))return false;
    }
    if (row.kind === 'task') {
      if (!isOwner || !taskGraphValid([...[...heads.values()].filter(entry => entry.entityId !== row.entityId), row])) return false;
    } else if (row.kind === 'attempt') {
      if (previous?.kind === 'attempt') {
        if (row.attemptNo !== previous.attemptNo || row.taskRevision !== previous.taskRevision ||
            row.ownerMembershipId !== previous.ownerMembershipId || row.ownerAgentId !== previous.ownerAgentId ||
            canonicalSha256(row.consumedDependencies) !== canonicalSha256(previous.consumedDependencies) ||
            (previous.member !== null && canonicalSha256(row.member) !== canonicalSha256(previous.member))) return false;
        if (['settled','stopped'].includes(previous.state) && row.state !== previous.state) return false;
        if (previous.stop.requested && !row.stop.requested) return false;
      } else if (!isOwner || row.state !== 'reserved' || task?.kind !== 'task' || row.taskRevision !== task.revision || row.member !== null) return false;
      if(['settled','stopped'].includes(row.state) && !['settled','stopped'].includes(previous?.kind==='attempt'?previous.state:'')) {
        if(!isOwner || row.terminalProof==null || row.terminalProof.evidence.length===0)return false;
        const current=[...heads.values()];
        if(current.some(item=>(item.kind==='action' && item.attemptId===row.attemptId && ['intended','issued','uncertain','held'].includes(item.state)) ||
          (item.kind==='resource' && item.attemptId===row.attemptId && item.disposition!=='released') || (item.kind==='delivery' && item.attemptId===row.attemptId && item.state!=='handled')))return false;
        const everIssued=ledger.taskEntries.some(item=>item.kind==='action' && item.attemptId===row.attemptId && ['send','create'].includes(item.actionKind) && ['issued','uncertain','observed','held'].includes(item.state));
        if(row.terminalProof.kind==='never-authorized-work' && everIssued)return false;
        if(row.terminalProof.kind==='observed-quiescence' && row.terminalProof.observationRefs.length===0)return false;
      }
      if (row.member !== null) {
        const bound = members.get(row.member.membershipId);
        if (!bound || bound.agentId !== row.member.agentId || bound.provider !== row.seatPin.provider ||
            bound.createCwd !== row.placement.cwd || bound.workspaceId !== row.placement.workspaceId) return false;
        const assignment = ledger.assignments.find(a => a.assignmentId === row.assignmentId)!;
        if (!assignment.seats.some(seat => seat.agentId === row.member!.agentId && seat.membershipId === row.member!.membershipId)) return false;
      }
    } else if (row.kind === 'result') {
      if (attempt?.kind !== 'attempt' || attempt.taskId !== row.taskId || attempt.assignmentId !== row.assignmentId || row.taskRevision !== attempt.taskRevision ||
          canonicalSha256(row.consumedDependencies) !== canonicalSha256(attempt.consumedDependencies)) return false;
      if (row.scopeId !== attempt.boundScopeId || row.scopeRevision !== attempt.boundScopeRevision) return false;
      if (row.candidate !== null && row.candidate.snapshotSha256 !== row.snapshotSha256) return false;
    } else if (row.kind === 'adjudication') {
      const result = get(row.resultId, 'result');
      if (!isOwner || result?.kind !== 'result' || result.taskId !== row.taskId || result.assignmentId !== row.assignmentId ||
          row.resultRevision !== result.revision || row.resultEntrySha256 !== result.entrySha256 || row.attemptId !== result.attemptId || task?.kind !== 'task' || row.taskRevision !== task.revision ||
          canonicalSha256(row.dependencyPins) !== canonicalSha256(result.consumedDependencies) || row.proofPolicyDigest !== (task.proofPolicy === null ? null : canonicalSha256(task.proofPolicy))) return false;
    } else if (row.kind === 'hold') {
      if (row.attemptId !== null && (attempt?.kind !== 'attempt' || attempt.taskId !== row.taskId)) return false;
      if (previous === undefined) {
        if (row.state !== 'open' || row.ruling !== null) return false;
      } else if (previous.kind === 'hold') {
        const bodyUnchanged = row.attemptId === previous.attemptId && row.holdKind === previous.holdKind &&
          row.question === previous.question && row.proposition === previous.proposition &&
          canonicalSha256(row.claimRefs) === canonicalSha256(previous.claimRefs) &&
          canonicalSha256(row.resourceIds) === canonicalSha256(previous.resourceIds);
        const firstRuling = previous.state === 'open' && previous.ruling === null;
        const releaseRetained = previous.state === 'ruled' && previous.ruling?.outcome === 'retain' &&
          (row.ruling?.outcome === 'release' || row.ruling?.outcome === 'withdraw');
        if (!bodyUnchanged || row.state !== 'ruled' || (!firstRuling && !releaseRetained) || !isOwner || row.ruling === null ||
            row.ruling.ownerMembershipId !== row.actorMembershipId || row.ruling.ownerAgentId !== row.actorAgentId ||
            row.ruling.briefRevision !== row.briefRevision) return false;
      }
    } else if (row.kind === 'action') {
      if (row.attemptId !== null && (attempt?.kind !== 'attempt' || attempt.taskId !== row.taskId || attempt.assignmentId !== row.assignmentId)) return false;
      if (previous?.kind === 'action') {
        if (row.ordinal !== previous.ordinal || row.actionKind !== previous.actionKind || row.attemptId !== previous.attemptId || row.resultId !== previous.resultId) return false;
        if (row.actionKind === 'create' && (row.bodySha256 !== previous.bodySha256 || canonicalSha256(row.body) !== canonicalSha256(previous.body))) return false;
        if (previous.cleanupVerification != null && canonicalSha256(row.cleanupVerification ?? null) !== canonicalSha256(previous.cleanupVerification)) return false;
        const issueEvidenceChanged = canonicalSha256(row.cleanupIssueEvidence ?? null) !== canonicalSha256(previous.cleanupIssueEvidence ?? null);
        const resetIssueEvidenceForContinuation = issueEvidenceChanged && previous.cleanupIssueEvidence != null && row.cleanupIssueEvidence == null &&
          row.state === 'intended' && row.phase === 'discharge' && previous.receipt?.cleanupObservation !== undefined &&
          cleanupContinuationIntentAllowed(ledger, row, previous, heads, isOwner);
        const issueEvidenceCommittedOnIssue = issueEvidenceChanged && previous.cleanupIssueEvidence == null && row.cleanupIssueEvidence != null &&
          cleanupIssuePreflightHistoryValid(ledger, row, previous, heads, isOwner);
        if (issueEvidenceChanged && !resetIssueEvidenceForContinuation && !issueEvidenceCommittedOnIssue) return false;
        const beforePlan=previous.recoveryPlan??null, afterPlan=row.recoveryPlan??null;
        if (row.actionKind === 'integration' && (beforePlan!==null || afterPlan!==null) && canonicalSha256(row.target) !== canonicalSha256(previous.target)) return false;
        if (beforePlan!==null && (afterPlan===null || canonicalSha256(afterPlan)!==canonicalSha256(beforePlan))) return false;
        if (beforePlan===null && afterPlan!==null) {
          const parsed=DeskTaskIntegrationRecoveryPlan.safeParse(afterPlan);
          const body=row.body as Record<string,unknown>|null;
          const controlPins=body?.controlPins as Record<string,unknown>|undefined;
          const result=get(row.resultId,'result');
          const adjudication=result?.kind==='result'?[...heads.values()].filter(item=>item.kind==='adjudication' && item.resultId===result.resultId)
            .sort((a,b)=>b.revision-a.revision)[0]:undefined;
          const request=ledger.requests.find(item=>item.actorKey===`agent:${row.actorAgentId}` && item.assignmentId===row.assignmentId && item.requestId===row.requestId);
          if(row.actionKind!=='integration' || !parsed.success || row.phase!=='land' || row.state!=='intended' || body?.phase!=='land' ||
              !DeskTaskIntegrationRecoveryPlan.safeParse(body.recoveryPlan).success || canonicalSha256(body.recoveryPlan)!==canonicalSha256(afterPlan) ||
              previous.phase!=='stage' && previous.phase!=='check' || !['observed','held'].includes(previous.state) ||
              afterPlan.stageDir!==row.stageDir || afterPlan.backupDir!==row.backupDir || afterPlan.expectedCombined.mapSha256!==row.expectedSha ||
              afterPlan.targetOriginal.head!==(row.target?.head??null) || afterPlan.expectedCombined.head!==afterPlan.targetOriginal.head ||
              controlPins?.assignmentId!==row.assignmentId || controlPins?.taskId!==row.taskId || controlPins?.resultId!==row.resultId ||
              controlPins?.expectedActionRevision!==previous.revision || request===undefined || controlPins?.expectedLedgerRevision!==request.revision-1 ||
              controlPins?.expectedResultRevision!==result?.revision || controlPins?.expectedAdjudicationRevision!==adjudication?.revision) return false;
        }
        if (row.state === 'issued' && previous.state !== 'intended') return false;
        const unissuedVerificationContinuation = previous.kind === 'action' && row.kind === 'action' &&
          unissuedCleanupVerificationContinuationAllowed(ledger, row, previous, isOwner);
        if (row.state === 'intended' && (row.actionKind !== 'integration' ||
            (!['observed','held'].includes(previous.state) && !unissuedVerificationContinuation))) return false;
        const integrationReconcileEdge = row.actionKind === 'integration' && previous.kind === 'action' &&
          taskIntegrationReconcileEdgeAllowed(previous, row.state, row.receipt,
            [...heads.values()].filter((item): item is DeskTaskResourceEntryValue => item.kind === 'resource' && item.actionId === row.actionId));
        if (row.actionKind === 'integration' && row.phase === 'discharge' && row.state === 'issued' &&
            row.body?.cleanupStep === 'remove-resource' && !cleanupIssuePreflightHistoryValid(ledger, row, previous, heads, isOwner)) return false;
        if (['observed','failed','uncertain','held','abandoned'].includes(row.state) &&
            !['issued','uncertain','held'].includes(previous.state) &&
            !(row.state === 'abandoned' && previous.state === 'intended' && isOwner) && !integrationReconcileEdge) return false;
      } else if (!isOwner || (row.actionKind === 'integration' ? row.state !== 'issued' : row.state !== 'intended')) return false;
      if (row.recoveryPlan != null && (!DeskTaskIntegrationRecoveryPlan.safeParse(row.recoveryPlan).success || row.actionKind!=='integration')) return false;
      if (row.actionKind==='integration' && row.recoveryPlan!=null && row.receipt!==null &&
          ['land','reconcile','discharge'].includes(String(row.receipt.phase)) &&
          (!DeskTaskIntegrationRecoveryPlan.safeParse(row.receipt.recoveryPlan).success || canonicalSha256(row.receipt.recoveryPlan)!==canonicalSha256(row.recoveryPlan))) return false;
      if(row.actionKind==='integration' && row.recoveryPlan!=null) {
        const plan=row.recoveryPlan;
        const body=row.body as Record<string,unknown>|null;
        const pins=(value:unknown)=>typeof value==='object' && value!==null?value as Record<string,unknown>:null;
        const controlPins=pins(body?.controlPins);
        const result=get(row.resultId,'result');
        const adjudication=result?.kind==='result'?[...heads.values()].filter(item=>item.kind==='adjudication' && item.resultId===result.resultId)
          .sort((a,b)=>b.revision-a.revision)[0]:undefined;
        const request=ledger.requests.find(item=>item.actorKey===`agent:${row.actorAgentId}` && item.assignmentId===row.assignmentId && item.requestId===row.requestId);
        const controlsMatch=(value:unknown,previousAction:DeskTaskEntryValue|undefined)=>{
          const valuePins=pins(value);
          return previousAction?.kind==='action' && valuePins!==null && result?.kind==='result' && adjudication?.kind==='adjudication' && request!==undefined &&
            valuePins.assignmentId===row.assignmentId && valuePins.taskId===row.taskId && valuePins.resultId===row.resultId &&
            valuePins.expectedActionRevision===previousAction.revision && valuePins.expectedLedgerRevision===request.revision-1 &&
            valuePins.expectedResultRevision===result.revision && valuePins.expectedAdjudicationRevision===adjudication.revision;
        };
        if(row.state==='intended' && row.phase==='discharge') {
          const priorReceipt=previous?.kind==='action'?previous.receipt as Record<string,unknown>|null:null;
          if(previous?.kind!=='action' || body?.phase!=='discharge' || canonicalSha256(body.recoveryPlan)!==canonicalSha256(plan) ||
              !controlsMatch(controlPins,previous) || body.grantRef!==previous.grant?.authorityRef) return false;
          if(previous?.kind === 'action' && unissuedCleanupVerificationContinuationAllowed(ledger,row,previous,isOwner)) {
            // A fresh public request may consume the sole continuation after
            // an admitted proof-only intent whose issue never committed.
            // The Core decide separately caps total intents at two and binds
            // this row's new controls to its own request/event.
          } else if(priorReceipt?.cleanupObservation!==undefined) {
            if(!cleanupContinuationIntentAllowed(ledger,row,previous,heads,isOwner))return false;
          } else if((priorReceipt?.phase!=='land' && priorReceipt?.phase!=='reconcile') || priorReceipt.status!=='observed' ||
              priorReceipt.backupIntegrity!==true || !['full-applied','original'].includes(String(priorReceipt.recoveryClassification)) ||
              priorReceipt.finalMatchesExpected!==(priorReceipt.recoveryClassification==='full-applied') ||
              (priorReceipt.recoveryClassification==='original' && previous.landed!==null) || body.cleanupStep!=='verify-account') return false;
        }
        if(row.receipt!==null && ['land','reconcile','discharge'].includes(String(row.receipt.phase))) {
          const receipt=row.receipt as Record<string,unknown>, phase=receipt.phase;
          const hasCleanupLineage=receipt.cleanupTrigger!==undefined || receipt.cleanupObservation!==undefined;
          if(phase==='land' || phase==='discharge') {
            const previousBody=previous?.kind==='action'?previous.body as Record<string,unknown>|null:null;
            if(previous?.kind!=='action' || previousBody?.phase!==phase ||
                canonicalSha256(receipt.controlPins??null)!==canonicalSha256(previousBody.controlPins??null))return false;
          } else if(!controlsMatch(receipt.controlPins,previous))return false;
          if(!hasCleanupLineage && phase==='land') {
            if(receipt.recoveryClassification==='full-applied') {
              const final=DeskTaskMeasurePin.safeParse(receipt.final);
              if(receipt.status!=='observed' || receipt.backupIntegrity!==true || receipt.finalMatchesExpected!==true || !final.success ||
                  row.targetCwd===null || final.data.root!==row.targetCwd || final.data.head!==plan.expectedCombined.head || final.data.incomplete.length!==0 ||
                  (row.target!==null && final.data.kind!==row.target.kind) || receipt.recoveredLand!==undefined) return false;
            } else if(receipt.recoveryClassification==='partial' || receipt.recoveryClassification==='unknown') {
              if(receipt.status!=='held' || receipt.finalMatchesExpected!==false || receipt.final!==undefined || receipt.recoveredLand!==undefined) return false;
            } else return false;
          } else if(!hasCleanupLineage && phase==='reconcile') {
            if(receipt.recoveryClassification==='full-applied') {
              const target=DeskTaskMeasurePin.safeParse(receipt.target), landed=DeskTaskMeasurePin.safeParse(receipt.recoveredLand);
              if(receipt.status!=='observed' || receipt.backupIntegrity!==true || receipt.finalMatchesExpected!==true || !target.success || !landed.success ||
                  row.targetCwd===null || target.data.root!==row.targetCwd || landed.data.root!==row.targetCwd ||
                  target.data.head!==plan.expectedCombined.head || landed.data.head!==plan.expectedCombined.head ||
                  target.data.kind!==landed.data.kind || target.data.snapshotSha256!==landed.data.snapshotSha256 ||
                  target.data.incomplete.length!==0 || landed.data.incomplete.length!==0) return false;
            } else if(receipt.recoveryClassification==='original') {
              const target=DeskTaskMeasurePin.safeParse(receipt.target);
              if(receipt.status!=='observed' || receipt.backupIntegrity!==true || receipt.finalMatchesExpected!==false || !target.success ||
                  row.targetCwd===null || target.data.root!==row.targetCwd || target.data.head!==plan.targetOriginal.head || target.data.incomplete.length!==0 ||
                  (row.target!==null && (target.data.kind!==row.target.kind || target.data.snapshotSha256!==row.target.snapshotSha256)) || receipt.recoveredLand!==undefined) return false;
            } else if(receipt.recoveryClassification==='partial' || receipt.recoveryClassification==='unknown') {
              if(receipt.status!=='held' || receipt.finalMatchesExpected!==false || receipt.recoveredLand!==undefined) return false;
            } else return false;
          } else if(!hasCleanupLineage) {
          const paths=[plan.stageDir,plan.backupDir],removed=receipt.removed,errors=receipt.errors;
          if(receipt.grantRef!==row.grant?.authorityRef || !Array.isArray(receipt.admittedPaths) || canonicalSha256(receipt.admittedPaths)!==canonicalSha256(paths) ||
              !Array.isArray(removed) || new Set(removed).size!==removed.length || removed.some(value=>!paths.includes(value)) ||
              !Array.isArray(errors) || errors.some(value=>typeof value!=='string'))return false;
          if(receipt.status==='observed') {if(errors.length!==0 || canonicalSha256(removed)!==canonicalSha256(paths))return false;}
            else if(receipt.status==='failed') {if(errors.length===0)return false;}
            else return false;
          }
        }
      }
      if (row.actionKind === 'integration' && previous?.kind === 'action' && row.receipt !== null &&
          typeof row.receipt === 'object' && row.receipt !== null &&
          ('cleanupTrigger' in row.receipt || 'cleanupObservation' in row.receipt) &&
          !cleanupReceiptHistoryValid(ledger, row, previous, heads, row.receipt as Record<string, unknown>, isOwner)) return false;
      if (row.bodySha256 !== (row.body === null ? null : canonicalSha256(row.body))) return false;
    } else if (row.kind === 'delivery' && previous?.kind === 'delivery') {
      if (row.recipientMembershipId !== previous.recipientMembershipId || row.recipientAgentId !== previous.recipientAgentId || row.senderMembershipId !== previous.senderMembershipId || row.actionId !== previous.actionId) return false;
      const states = ['pending','host-accepted','responsibility-acknowledged','handled'];
      if (states.indexOf(row.state) <= states.indexOf(previous.state) || (row.state === 'handled' && previous.state !== 'responsibility-acknowledged')) return false;
      if (['responsibility-acknowledged','handled'].includes(row.state) && row.actorMembershipId !== row.recipientMembershipId) return false;
    } else if (row.kind === 'resource' && previous?.kind === 'resource') {
      if (row.resourceKind !== previous.resourceKind || row.resourceKey !== previous.resourceKey || row.attemptId !== previous.attemptId || previous.disposition === 'released') return false;
      if (row.disposition === 'released' && (!isOwner || row.releaseRuling === null || row.releaseRuling.evidence.length === 0)) return false;
      if(row.disposition==='released' && row.actionId!==null) {
        const action=get(row.actionId,'action');
        if(action?.kind==='action' && action.actionKind==='integration') {
          const receipt=action.receipt as Record<string,unknown>|null;
          const admitted=action.recoveryPlan===undefined||action.recoveryPlan===null
            ? (action.stageDir===null?[]:[action.stageDir]) : [action.recoveryPlan.stageDir,action.recoveryPlan.backupDir];
          const cleanupObservation=DeskTaskIntegrationCleanupObservation.safeParse(receipt?.cleanupObservation);
          if(cleanupObservation.success) {
            if(cleanupObservation.data.cleanupStep!=='remove-resource' && cleanupObservation.data.cleanupStep!=='reconcile-progress')return false;
            const resourceObservation=cleanupObservation.data as Extract<DeskTaskIntegrationCleanupObservationValue,{cleanupStep:'remove-resource'|'reconcile-progress'}>;
            const summary=resourceObservation.resources.find(item=>item.resourceId===row.resourceId);
            const permit=DeskTaskIntegrationCleanupPermit.safeParse(resourceObservation.permit);
            if(action.requestId!==row.requestId || resourceObservation.status!=='observed' || !permit.success ||
                !['discharge','reconcile'].includes(String(receipt?.phase)) ||
                (receipt?.phase==='discharge' ? receipt.grantRef!==action.grant?.authorityRef : receipt?.grantRef!==null) ||
                summary===undefined || summary.resourceKey!==row.resourceKey || summary.missingPathCount!==summary.expectedEntryCount ||
                summary.survivorEntryCount!==0 || permit.data.resourceId!==row.resourceId || !admitted.includes(row.resourceKey) ||
                !row.releaseRuling?.evidence.includes(`cleanup:${action.actionId}`))return false;
          } else if(action.requestId!==row.requestId || receipt?.phase!=='discharge' || receipt.status!=='observed' ||
              receipt.grantRef!==action.grant?.authorityRef || !Array.isArray(receipt.admittedPaths) || !receipt.admittedPaths.includes(row.resourceKey) ||
              !Array.isArray(receipt.removed) || !receipt.removed.includes(row.resourceKey) || !admitted.includes(row.resourceKey) ||
              !row.releaseRuling?.evidence.includes(`cleanup:${action.actionId}`))return false;
        }
      }
    }
    heads.set(row.entityId, row);
  }
  for(const row of heads.values())if(row.kind==='action' && row.actionKind==='integration' && row.recoveryPlan!=null) {
    const parsed=DeskTaskIntegrationRecoveryPlan.safeParse(row.recoveryPlan);
    if(!parsed.success || row.resourceIds===null || new Set(row.resourceIds).size!==2)return false;
    const plan=parsed.data;
    const resources=row.resourceIds.map(id=>heads.get(id));
    if(resources.some(resource=>resource?.kind!=='resource' || resource.assignmentId!==row.assignmentId || resource.taskId!==row.taskId || resource.actionId!==row.actionId) ||
        !resources.some(resource=>resource?.kind==='resource' && resource.resourceKey===plan.stageDir && resource.resourceKind===(row.stageKind==='git-worktree'?'worktree':'scratch')) ||
        !resources.some(resource=>resource?.kind==='resource' && resource.resourceKey===plan.backupDir && resource.resourceKind==='scratch'))return false;
  }
  for (const transition of ledger.scopeTransitions) {
    if (transition.command !== 'task-cancel') { if (transition.taskCancellation !== undefined) return false; continue; }
    const pin = transition.taskCancellation;
    const attempt = pin === undefined ? undefined : byEntry.get([...byEntry.values()].find(row => row.kind === 'attempt' && row.attemptId === pin.attemptId && row.revision === pin.attemptRevision)?.entryId ?? '');
    const control = pin === undefined ? undefined : [...byEntry.values()].find(row => row.kind === 'control' && row.controlId === pin.controlId && row.entrySha256 === pin.controlEntrySha256);
    const event = events.find(row => row.kind === 'scope-transitioned' && row.assignmentId === transition.assignmentId && row.requestId === transition.requestId && row.payload.scopeId === transition.scopeId && row.payload.command === 'task-cancel');
    if (!pin || attempt?.kind !== 'attempt' || control?.kind !== 'control' || attempt.entrySha256 !== pin.attemptEntrySha256 ||
        attempt.state !== 'stopped' || attempt.terminalProof == null || canonicalSha256(attempt.terminalProof) !== pin.proofSha256 ||
        attempt.requestId !== transition.requestId || control.requestId !== transition.requestId || control.state !== 'stop-observed' ||
        attempt.assignmentId !== transition.assignmentId || attempt.boundScopeId !== transition.scopeId || attempt.boundScopeRevision !== transition.scopeRevision ||
        control.targetAttemptId !== attempt.attemptId || attempt.actorAgentId !== transition.actorAgentId || control.actorMembershipId !== attempt.actorMembershipId ||
        event === undefined || canonicalSha256(event.payload.taskCancellation) !== canonicalSha256(pin)) return false;
    const taskEvent = entryEvents.find(row => row.payload.entryId === attempt.entryId);
    const controlEvent = entryEvents.find(row => row.payload.entryId === control.entryId);
    if (!taskEvent || !controlEvent || taskEvent.requestId !== event.requestId || controlEvent.requestId !== event.requestId) return false;
  }
  const seatMintEvents = events.filter(event => event.kind === 'seat-minted');
  for (const membership of ledger.memberships) {
    const claim = membership.capacityClaim;
    if (claim == null) continue;
    const mintMatches = seatMintEvents.filter(event => event.payload.membershipId === membership.membershipId &&
      event.payload.capacityClaimSha256 === canonicalSha256(claim));
    if (mintMatches.length !== 1 || mintMatches[0]!.actorKey !== 'desk:hook' || mintMatches[0]!.assignmentId !== 'unassigned' ||
        Date.parse(membership.createdAt) > Date.parse(mintMatches[0]!.at) ||
        ledger.memberships.filter(row => row.capacityClaim?.createActionId === claim.createActionId).length !== 1) return false;
    const mintEvent = mintMatches[0]!;
    const issue = byEntry.get(claim.createIssueRef.entryId);
    const issueEvent = taskEntryEventById.get(claim.createIssueRef.entryId);
    if (issue?.kind !== 'action' || issue.entrySha256 !== claim.createIssueRef.entrySha256 || issueEvent === undefined ||
        issueEvent.seq >= mintEvent.seq || issue.actionKind !== 'create' || issue.state !== 'issued' || issue.phase !== null ||
        issue.body === null || issue.assignmentId === '' || issue.taskId === '' || issue.attemptId !== claim.attemptId ||
        issue.actionId !== claim.createActionId || issue.body.hostRequestId !== claim.hostRequestId ||
        typeof issue.body.idempotencyKey !== 'string' || sha256Hex(issue.body.idempotencyKey) !== claim.idempotencyKeySha256) return false;
    if (claim.version === 2 && (issue.body.createTicketSha256 !== claim.ticketSha256 ||
        issue.bodySha256 !== claim.intendedBodySha256 || typeof issue.body.publicRequestId !== 'string' ||
        issue.body.publicRequestId.length === 0 || !/^[0-9a-f]{64}$/.test(String(issue.body.publicRequestSha256 ?? '')))) return false;
    const assignment = issue.assignmentId;
    const ownershipRevisionAtMint = events.filter(event => event.kind === 'ownership-accepted' && event.assignmentId === assignment && event.seq < mintEvent.seq).length;
    const owner = ownerAt(assignment, mintEvent.seq);
    if (issue.actorAgentId !== owner.agentId || issue.actorMembershipId !== owner.membershipId || issue.callerAgentId !== owner.agentId ||
        issue.body.parent !== owner.agentId || issue.ownershipRevision !== ownershipRevisionAtMint ||
        issue.briefRevision !== briefAt(assignment, mintEvent.seq)) return false;
    const attemptAtMint = ledger.taskEntries.filter((item): item is Extract<DeskTaskEntryValue, { kind: 'attempt' }> => item.kind === 'attempt' &&
      item.attemptId === claim.attemptId && item.assignmentId === assignment && (taskEntryEventById.get(item.entryId)?.seq ?? Number.POSITIVE_INFINITY) < mintEvent.seq)
      .sort((a, b) => b.revision - a.revision)[0];
    const taskAtMint = ledger.taskEntries.filter((item): item is DeskTaskDeclarationEntryValue => item.kind === 'task' &&
      item.taskId === issue.taskId && item.assignmentId === assignment && (taskEntryEventById.get(item.entryId)?.seq ?? Number.POSITIVE_INFINITY) < mintEvent.seq)
      .sort((a, b) => b.revision - a.revision)[0];
    if (attemptAtMint === undefined || taskAtMint === undefined || attemptAtMint.state !== 'reserved' || attemptAtMint.member !== null ||
        attemptAtMint.taskRevision !== taskAtMint.revision || taskAtMint.state === 'withdrawn' ||
        attemptAtMint.ownerAgentId !== owner.agentId || attemptAtMint.ownerMembershipId !== owner.membershipId ||
        attemptAtMint.ownershipRevision !== ownershipRevisionAtMint || attemptAtMint.briefRevision !== issue.briefRevision ||
        issue.briefRevision !== taskAtMint.briefRevision || attemptAtMint.seatPin.provider !== membership.provider ||
        attemptAtMint.seatPin.model !== (issue.body.seat as Record<string, unknown> | undefined)?.model ||
        membership.createCwd !== attemptAtMint.placement.cwd ||
        // Mint precedes native creation: its unbound row has no observed
        // workspace yet. The immutable placement still pins the expectation;
        // once session-open binds the agent, its workspace must match it.
        (membership.agentId !== null && attemptAtMint.placement.workspaceId !== membership.workspaceId)) return false;
    const latestCreates = new Map<string, Extract<DeskTaskEntryValue, { kind: 'action' }>>();
    for (const item of ledger.taskEntries) {
      if (item.kind !== 'action' || item.actionKind !== 'create' || item.attemptId !== claim.attemptId ||
          (taskEntryEventById.get(item.entryId)?.seq ?? Number.POSITIVE_INFINITY) >= mintEvent.seq) continue;
      const prior = latestCreates.get(item.actionId);
      if (prior === undefined || prior.revision < item.revision) latestCreates.set(item.actionId, item);
    }
    const currentIssued = [...latestCreates.values()].filter(item => item.state === 'issued');
    const roleSuffix = /-(supervisor|lead|peer)$/.exec(attemptAtMint.seatPin.provider)?.[1];
    const marker = attemptAtMint.seatPin.features?.['slp_role'];
    const expectedRole = roleSuffix ?? (typeof marker === 'string' && ROLES.includes(marker as typeof ROLES[number]) ? marker : null);
    const labels = issue.body.labels;
    const placement = issue.body.placement;
    if (!isHistoryRecord(labels) || !isHistoryRecord(placement)) return false;
    if (currentIssued.length !== 1 || currentIssued[0]!.actionId !== issue.actionId ||
        membership.family !== familyFromProviderId(attemptAtMint.seatPin.provider) || expectedRole !== membership.role ||
        issue.body.seat === undefined || canonicalSha256(issue.body.seat) !== canonicalSha256(attemptAtMint.seatPin) ||
        issue.body.runtime === undefined || canonicalSha256(issue.body.runtime) !== canonicalSha256(attemptAtMint.runtime) ||
        labels['slp.repo'] !== ledger.repo.repoKey || labels['slp.assignment'] !== issue.assignmentId ||
        labels['slp.task'] !== issue.taskId || labels['slp.attempt'] !== claim.attemptId ||
        Object.hasOwn(labels, 'slp.create-action') ||
        placement.cwd !== attemptAtMint.placement.cwd || placement.kind !== attemptAtMint.placement.kind) return false;
  }
  return true;
}

function isHistoryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
