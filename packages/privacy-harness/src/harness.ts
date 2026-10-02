import { PrivacyLeakError, type Finding } from './finding.js';
import { MarkerSet } from './markers.js';
import { scanStructure, scanText } from './scan.js';
import {
  DEFAULT_NOTIFICATION_POLICY,
  EventSink,
  GrpcSink,
  HttpSink,
  LogSink,
  NotificationSink,
  TraceSink,
  type NotificationPolicy,
  type Sink,
} from './sinks.js';

export interface PrivacyHarness {
  markers: MarkerSet;
  logs: LogSink;
  events: EventSink;
  http: HttpSink;
  grpc: GrpcSink;
  traces: TraceSink;
  notifications: NotificationSink;
  /** Register another sink (cache keys, metrics, ...). */
  addSink: (sink: Sink) => void;
  sinks: () => readonly Sink[];
  /** Runs both scans over every sink and returns what it found. */
  scan: () => Finding[];
  /** Throws `PrivacyLeakError` if `scan` finds anything. */
  assertClean: () => void;
}

export interface HarnessOptions {
  seed?: string;
  notificationPolicy?: NotificationPolicy;
}

/** Creates a fresh set of sinks and markers. Plant `harness.markers` values, run the code, then `assertClean()`. */
export function createPrivacyHarness(options: HarnessOptions = {}): PrivacyHarness {
  const markers = new MarkerSet(options.seed);
  const logs = new LogSink();
  const events = new EventSink();
  const http = new HttpSink();
  const grpc = new GrpcSink();
  const traces = new TraceSink();
  const notifications = new NotificationSink(
    options.notificationPolicy ?? DEFAULT_NOTIFICATION_POLICY,
  );
  const all: Sink[] = [logs, events, http, grpc, traces, notifications];

  const scan = (): Finding[] =>
    all.flatMap((sink) => [
      ...sink.texts().flatMap((text) => scanText(sink.name, text, markers.all())),
      ...sink.documents().flatMap((doc) => scanStructure(sink.name, doc)),
      ...(sink.policyFindings?.() ?? []),
    ]);

  return {
    markers,
    logs,
    events,
    http,
    grpc,
    traces,
    notifications,
    addSink: (sink) => {
      all.push(sink);
    },
    sinks: () => all,
    scan,
    assertClean: () => {
      const findings = scan();
      if (findings.length > 0) throw new PrivacyLeakError(findings, markers.seed);
    },
  };
}
