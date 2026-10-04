import { buildTaskRecap } from '../plugin/server/runtime/handoff-recap.ts';
import type { TaskRecapEntryShape, TaskRecapRowShape } from '../plugin/server/runtime/handoff-recap.ts';
import type {
  DeskTaskRecapResultValue,
  DeskWorkflowProjectionItemValue,
  DeskWorkflowProjectionValue,
} from '../plugin/shared/enforcement.ts';

type SharedTaskProjection = DeskWorkflowProjectionValue & {
  section: 'tasks';
  taskCounts: NonNullable<DeskWorkflowProjectionValue['taskCounts']>;
};

declare const projection: SharedTaskProjection;

const recap = buildTaskRecap(projection);
const sharedResult: DeskTaskRecapResultValue = recap;
const originalProjection: SharedTaskProjection = recap.view;
const originalCounts: SharedTaskProjection['taskCounts'] = recap.counts;
type SharedTaskEntry = Extract<DeskWorkflowProjectionItemValue, { kind: 'taskEntry' }>;
type SharedHoldRow = Extract<SharedTaskEntry['row'], { kind: 'hold' }>;
type RuntimeHoldRow = Extract<TaskRecapRowShape, { kind: 'hold' }>;
declare const sharedTaskEntry: SharedTaskEntry;
declare const sharedHoldRow: SharedHoldRow;
const reducerEntry: TaskRecapEntryShape = sharedTaskEntry;
const reducerHoldRow: RuntimeHoldRow = sharedHoldRow;

void [sharedResult, originalProjection, originalCounts, reducerEntry, reducerHoldRow];
