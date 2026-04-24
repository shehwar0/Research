// ============================================================================
// fx-ts — Enterprise Observability (OpenTelemetry Integration)
// ============================================================================
// Provides OpenTelemetry-compatible tracing, metrics, and logging for
// algebraic effect handlers.
//
// This module does NOT depend on the @opentelemetry/* packages.
// Instead, it implements the OpenTelemetry data model so it can
// export to any OTel-compatible collector (Jaeger, Zipkin, Grafana).
//
// Design:
//   - Each effect `perform` is a span
//   - Handler chains form parent-child span trees
//   - Effect metadata maps to span attributes
//   - Errors map to span events
//   - Metrics: effect count, duration histogram, error rate
// ============================================================================

import type {
  Eff,
  EffectSignal,
  EffectReturn,
  Handler,
} from './types.js'
import { createHandler } from './core.js'

// ============================================================================
// OTel-Compatible Span Model
// ============================================================================

/**
 * A trace ID (128-bit, hex-encoded).
 */
export type TraceId = string & { readonly __brand: 'TraceId' }

/**
 * A span ID (64-bit, hex-encoded).
 */
export type SpanId = string & { readonly __brand: 'SpanId' }

/**
 * Generate a random trace ID.
 */
export function generateTraceId(): TraceId {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') as TraceId
}

/**
 * Generate a random span ID.
 */
export function generateSpanId(): SpanId {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') as SpanId
}

/**
 * Span status following the OTel specification.
 */
export type SpanStatus =
  | { code: 'UNSET' }
  | { code: 'OK' }
  | { code: 'ERROR'; message: string }

/**
 * A span attribute (key-value pair).
 */
export type SpanAttributes = Record<string, string | number | boolean | string[]>

/**
 * A span event (timestamped annotation).
 */
export interface SpanEvent {
  readonly name: string
  readonly timestamp: number
  readonly attributes?: SpanAttributes
}

/**
 * An OTel-compatible span representing an effect invocation.
 */
export interface EffectSpan {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId?: SpanId
  readonly name: string
  readonly kind: 'INTERNAL' | 'CLIENT' | 'SERVER'
  readonly startTime: number
  endTime?: number
  readonly attributes: SpanAttributes
  readonly events: SpanEvent[]
  status: SpanStatus
  readonly resource: SpanAttributes
}

// ============================================================================
// Span Exporter Interface
// ============================================================================

/**
 * Interface for exporting spans to external systems.
 * Implement this to connect to Jaeger, Zipkin, Grafana, etc.
 */
export interface SpanExporter {
  /**
   * Export a batch of completed spans.
   */
  export(spans: EffectSpan[]): Promise<void>

  /**
   * Shut down the exporter, flushing any pending spans.
   */
  shutdown(): Promise<void>
}

/**
 * Console span exporter for development/debugging.
 */
export class ConsoleSpanExporter implements SpanExporter {
  async export(spans: EffectSpan[]): Promise<void> {
    for (const span of spans) {
      const duration = span.endTime
        ? `${(span.endTime - span.startTime).toFixed(2)}ms`
        : 'in-progress'

      console.log(
        `[otel] ${span.name} ` +
        `trace=${span.traceId.slice(0, 8)} ` +
        `span=${span.spanId.slice(0, 8)} ` +
        `${duration} ` +
        `status=${span.status.code}`,
      )
    }
  }

  async shutdown(): Promise<void> {
    // No-op for console
  }
}

/**
 * In-memory span exporter for testing.
 */
export class InMemorySpanExporter implements SpanExporter {
  private _spans: EffectSpan[] = []

  async export(spans: EffectSpan[]): Promise<void> {
    this._spans.push(...spans)
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  get spans(): readonly EffectSpan[] {
    return this._spans
  }

  clear(): void {
    this._spans = []
  }
}

// ============================================================================
// Effect Tracer — OpenTelemetry-Compatible
// ============================================================================

/**
 * An effect tracer that creates spans for every effect invocation.
 *
 * @example
 * ```typescript
 * const tracer = new EffectTracer({
 *   serviceName: 'my-app',
 *   exporter: new ConsoleSpanExporter(),
 * })
 *
 * const traced = tracer.wrap(myHandler, 'MyHandler')
 * run(() => handle(traced, myComputation))
 *
 * await tracer.flush()
 * ```
 */
export class EffectTracer {
  private _serviceName: string
  private _exporter: SpanExporter
  private _pendingSpans: EffectSpan[] = []
  private _batchSize: number
  private _currentTraceId: TraceId
  private _spanStack: SpanId[] = []

  constructor(options: {
    serviceName: string
    exporter: SpanExporter
    batchSize?: number
  }) {
    this._serviceName = options.serviceName
    this._exporter = options.exporter
    this._batchSize = options.batchSize ?? 100
    this._currentTraceId = generateTraceId()
  }

  /**
   * Start a new trace context.
   */
  startTrace(): TraceId {
    this._currentTraceId = generateTraceId()
    this._spanStack = []
    return this._currentTraceId
  }

  /**
   * Wrap a handler with OTel-compatible tracing.
   */
  wrap<E extends EffectSignal>(
    handler: Handler<E>,
    handlerName?: string,
  ): Handler<E> {
    const name = handlerName ?? `handler(${[...handler.tags].join(',')})`

    return {
      tags: handler.tags,
      handles: handler.handles.bind(handler),
      handle: (effect: E, resume: (value: EffectReturn<E>) => void) => {
        const span = this._startSpan(effect, name)

        handler.handle(effect, (value: EffectReturn<E>) => {
          this._endSpan(span, value)
          resume(value)
        })
      },
    }
  }

  private _startSpan(effect: EffectSignal, handlerName: string): EffectSpan {
    const spanId = generateSpanId()
    const parentSpanId = this._spanStack.length > 0
      ? this._spanStack[this._spanStack.length - 1]
      : undefined

    this._spanStack.push(spanId)

    // Extract effect attributes (skip _tag and _Return)
    const attributes: SpanAttributes = {
      'fx.effect.tag': effect._tag,
      'fx.handler.name': handlerName,
      'fx.handler.depth': this._spanStack.length,
    }

    for (const [key, value] of Object.entries(effect)) {
      if (key === '_tag' || key === '_Return') continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        attributes[`fx.effect.${key}`] = value
      }
    }

    const span: EffectSpan = {
      traceId: this._currentTraceId,
      spanId,
      parentSpanId,
      name: `effect:${effect._tag}`,
      kind: 'INTERNAL',
      startTime: performance.now(),
      attributes,
      events: [],
      status: { code: 'UNSET' },
      resource: {
        'service.name': this._serviceName,
        'fx.version': '0.4.0',
      },
    }

    return span
  }

  private _endSpan(span: EffectSpan, _resumeValue: unknown): void {
    span.endTime = performance.now()
    span.status = { code: 'OK' }

    this._spanStack.pop()
    this._pendingSpans.push(span)

    // Auto-flush when batch is full
    if (this._pendingSpans.length >= this._batchSize) {
      this._flush()
    }
  }

  /**
   * Record an error on the current trace.
   */
  recordError(tag: string, error: unknown): void {
    const span: EffectSpan = {
      traceId: this._currentTraceId,
      spanId: generateSpanId(),
      parentSpanId: this._spanStack.length > 0
        ? this._spanStack[this._spanStack.length - 1]
        : undefined,
      name: `error:${tag}`,
      kind: 'INTERNAL',
      startTime: performance.now(),
      endTime: performance.now(),
      attributes: {
        'fx.effect.tag': tag,
        'exception.type': error instanceof Error ? error.constructor.name : typeof error,
        'exception.message': error instanceof Error ? error.message : String(error),
      },
      events: [{
        name: 'exception',
        timestamp: performance.now(),
        attributes: {
          'exception.stacktrace': error instanceof Error ? (error.stack ?? '') : '',
        },
      }],
      status: {
        code: 'ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
      resource: {
        'service.name': this._serviceName,
        'fx.version': '0.4.0',
      },
    }

    this._pendingSpans.push(span)
  }

  /**
   * Flush pending spans to the exporter.
   */
  async flush(): Promise<void> {
    await this._flush()
  }

  private async _flush(): Promise<void> {
    if (this._pendingSpans.length === 0) return
    const batch = this._pendingSpans.splice(0)
    await this._exporter.export(batch)
  }

  /**
   * Shutdown the tracer, flushing all pending spans.
   */
  async shutdown(): Promise<void> {
    await this._flush()
    await this._exporter.shutdown()
  }
}

// ============================================================================
// Effect Metrics — Counter & Histogram
// ============================================================================

/**
 * Metrics collector for effect operations.
 * Compatible with Prometheus/OTel metrics format.
 */
export class EffectMetrics {
  private _counters = new Map<string, number>()
  private _histograms = new Map<string, number[]>()
  private _gauges = new Map<string, number>()

  /** Increment a counter */
  inc(name: string, value: number = 1): void {
    this._counters.set(name, (this._counters.get(name) ?? 0) + value)
  }

  /** Record a histogram observation */
  observe(name: string, value: number): void {
    const values = this._histograms.get(name) ?? []
    values.push(value)
    this._histograms.set(name, values)
  }

  /** Set a gauge value */
  gauge(name: string, value: number): void {
    this._gauges.set(name, value)
  }

  /**
   * Export metrics in Prometheus text format.
   */
  toPrometheus(): string {
    const lines: string[] = []

    for (const [name, value] of this._counters) {
      lines.push(`# TYPE ${name} counter`)
      lines.push(`${name} ${value}`)
    }

    for (const [name, values] of this._histograms) {
      const sorted = [...values].sort((a, b) => a - b)
      const sum = sorted.reduce((a, b) => a + b, 0)
      const count = sorted.length

      lines.push(`# TYPE ${name} histogram`)
      lines.push(`${name}_count ${count}`)
      lines.push(`${name}_sum ${sum}`)

      // Standard histogram buckets
      for (const bucket of [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]) {
        const le = sorted.filter((v) => v <= bucket).length
        lines.push(`${name}_bucket{le="${bucket}"} ${le}`)
      }
      lines.push(`${name}_bucket{le="+Inf"} ${count}`)
    }

    for (const [name, value] of this._gauges) {
      lines.push(`# TYPE ${name} gauge`)
      lines.push(`${name} ${value}`)
    }

    return lines.join('\n')
  }

  /**
   * Export metrics as a JSON object.
   */
  toJSON(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(this._counters),
      histograms: Object.fromEntries(
        Array.from(this._histograms.entries()).map(([k, v]) => {
          const sorted = [...v].sort((a, b) => a - b)
          return [k, {
            count: v.length,
            sum: v.reduce((a, b) => a + b, 0),
            avg: v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : 0,
            min: sorted[0] ?? 0,
            max: sorted[sorted.length - 1] ?? 0,
            p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
            p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
          }]
        }),
      ),
      gauges: Object.fromEntries(this._gauges),
    }
  }

  /** Reset all metrics */
  reset(): void {
    this._counters.clear()
    this._histograms.clear()
    this._gauges.clear()
  }
}

/**
 * Create a handler wrapper that records metrics for every effect.
 *
 * @example
 * ```typescript
 * const metrics = new EffectMetrics()
 * const instrumented = instrumentHandler(handler, metrics)
 *
 * run(() => handle(instrumented, computation))
 *
 * console.log(metrics.toPrometheus())
 * ```
 */
export function instrumentHandler<E extends EffectSignal>(
  handler: Handler<E>,
  metrics: EffectMetrics,
): Handler<E> {
  return {
    tags: handler.tags,
    handles: handler.handles.bind(handler),
    handle(effect: E, resume: (value: EffectReturn<E>) => void) {
      metrics.inc(`fx_effect_total{tag="${effect._tag}"}`)
      const start = performance.now()

      handler.handle(effect, (value: EffectReturn<E>) => {
        const durationMs = performance.now() - start
        metrics.observe(`fx_effect_duration_ms{tag="${effect._tag}"}`, durationMs)
        resume(value)
      })
    },
  }
}
