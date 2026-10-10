// Desk adapter: re-export the shared validator without supplying filesystem
// capabilities. A seat's outputRef remains unreadable inside pure decide.
export {
  RECORD_KINDS,
  SHA256_PATTERN,
  HANDBACK_VERDICTS,
  SETTLEMENT_VIA,
  GIT_HEAD_PATTERN,
  UTC_TIMESTAMP_PATTERN,
  REPOSITORY_RELATIVE_PATH_PATTERN,
  recomputeSha,
  validateReportRecordV1,
  type RecordIssue,
  type RecordValidation,
  type EvidenceReadResult,
  type ReadEvidence,
  type Realpath,
  type ValidateOptions,
} from "./runtime/report-records.ts";
