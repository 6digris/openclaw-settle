import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

installRealOtelSdkTestHarness();

test.each([
  { type: "model.call.completed", metric: "openclaw.model_call.duration_ms" },
  { type: "model.call.error", metric: "openclaw.model_call.duration_ms" },
  { type: "tool.execution.completed", metric: "openclaw.tool.execution.duration_ms" },
  { type: "tool.execution.error", metric: "openclaw.tool.execution.duration_ms" },
] as const)("exports finite long-duration buckets for $type", async ({ type, metric }) => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter });
  const provider = new MeterProvider({ readers: [reader] });
  const durations = [30_000, 120_000, 900_000, 3_600_001];
  try {
    metrics.disable();
    expect(metrics.setGlobalMeterProvider(provider)).toBe(true);
    await startOtelService({ metrics: true });
    for (const durationMs of durations) {
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type,
          provider: "test-provider",
          model: "test-model",
          toolName: "test-tool",
          runId: "test-run",
          callId: "test-call",
          toolCallId: "test-tool-call",
          errorCategory: "timeout",
          durationMs,
        },
        {},
      );
    }
    await waitForDiagnosticEventsDrained();
    await provider.forceFlush();
    const exported = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
      .find((entry) => entry.descriptor.name === metric);
    expect(exported?.dataPointType).toBe(DataPointType.HISTOGRAM);
    if (exported?.dataPointType !== DataPointType.HISTOGRAM) {
      throw new Error(`Missing histogram: ${metric}`);
    }
    expect(exported.descriptor.unit).toBe("ms");
    expect(exported.dataPoints).toHaveLength(1);
    const { count, sum, buckets } = exported.dataPoints[0]!.value;
    expect(count).toBe(durations.length);
    expect(sum).toBe(durations.reduce((total, duration) => total + duration, 0));
    expect(buckets.boundaries.slice(0, 15)).toEqual([
      0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
    ]);
    expect(buckets.boundaries.at(-1)).toBe(3_600_000);
    for (const duration of durations.slice(0, -1)) {
      expect(buckets.boundaries).toContain(duration);
      expect(buckets.counts[buckets.boundaries.indexOf(duration)]).toBe(1);
    }
    expect(buckets.counts.at(-1)).toBe(1);
    expect(buckets.counts.reduce((total, bucket) => total + bucket, 0)).toBe(count);
  } finally {
    try {
      await stopStartedOtelServices();
    } finally {
      await provider.shutdown();
    }
  }
});
