/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// OpenTelemetry OTLP export has been removed from this build. This module is a
// no-op shim that preserves the telemetry-SDK public surface so the rest of the
// codebase compiles and runs unchanged, but NO telemetry SDK is initialized and
// nothing is ever exported off the machine. The in-memory `uiTelemetryService`
// (local stats) and the `@opentelemetry/api` no-op tracer/meter continue to work.

export function isTelemetrySdkInitialized(): boolean {
  return false;
}

export function initializeTelemetry(): void {
  // OTLP export removed: intentionally a no-op. No exporters, no SDK, no egress.
}

export function refreshSessionContext(_sessionId: string): void {
  // OTLP export removed: there is no SDK session context to refresh.
}

export async function shutdownTelemetry(): Promise<void> {
  // OTLP export removed: nothing to flush or shut down.
}

export async function forceFlushMetrics(): Promise<void> {
  // OTLP export removed: there is no metric reader to flush.
}
