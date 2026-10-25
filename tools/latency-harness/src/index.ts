/**
 * Reusable measurement core for the latency harness.
 *
 * Wall-clock timing is legitimate here because this is a benchmark, not engine
 * code; the simulated-time rule applies to session replay. M0 records harness
 * overhead only (fake-clock dispatch, event serialization, trace append) and
 * freezes no latency budget.
 */
export {
  percentile,
  quantileOfSorted,
  summarizeDurations,
  type PercentileSummary,
} from './percentiles.js'
export {
  measureAsync,
  measureSync,
  type AsyncMeasureOptions,
  type MeasurementReport,
  type SyncMeasureOptions,
} from './measure.js'
export {
  DEFAULT_FAKE_CLOCK_SLEEPERS,
  createEventSerializationWorkload,
  createFakeClockDispatchWorkload,
  createTraceAppendWorkload,
  createTraceRecord,
  type AsyncWorkload,
  type SyncWorkload,
} from './workloads.js'
export {
  DEFAULT_REPORT_PATH,
  buildHarnessReport,
  writeHarnessReport,
  type HarnessReport,
  type HarnessReportArtifact,
} from './report.js'
