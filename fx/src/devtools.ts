// ============================================================================
// fx-ts — DevTools: Effect Inspector, Visualizer & Performance Profiler
// ============================================================================
// Production-grade development and debugging tools for algebraic effects.
//
// Provides:
//   1. Effect Inspector — trace and log every effect perform/resume
//   2. Effect Visualizer — structured effect flow visualization 
//   3. Performance Profiler — measure handler & effect timing
//   4. Handler Stack Inspector — view the current handler chain
//
// These tools are designed to be zero-overhead in production:
// they only activate when explicitly enabled.
// ============================================================================

import type {
  Eff,
  EffectSignal,
  EffectReturn,
  Handler,
} from './types.js'
import { createHandler } from './core.js'

// ============================================================================
// Effect Trace — Recording Effect Events
// ============================================================================

/**
 * A single effect event in the trace log.
 */
export interface EffectEvent {
  /** Event type */
  readonly type: 'perform' | 'resume' | 'handle' | 'unhandled' | 'error'
  /** The effect tag */
  readonly tag: string
  /** The full effect signal */
  readonly effect: EffectSignal
  /** Timestamp in microseconds (performance.now() * 1000) */
  readonly timestamp: number
  /** Duration in microseconds (for handle/resume pairs) */
  readonly duration?: number
  /** The value sent back on resume */
  readonly resumeValue?: unknown
  /** Parent event index (for nesting) */
  readonly parent?: number
  /** Depth in the handler stack */
  readonly depth: number
  /** Handler that processed this effect */
  readonly handlerName?: string
}

/**
 * The effect trace — a recording of all effect events.
 */
export class EffectTrace {
  private _events: EffectEvent[] = []
  private _active = true
  private _maxEvents: number

  constructor(maxEvents: number = 10_000) {
    this._maxEvents = maxEvents
  }

  /** Record an event */
  record(event: Omit<EffectEvent, 'timestamp'>): void {
    if (!this._active) return
    if (this._events.length >= this._maxEvents) {
      // Ring buffer — overwrite oldest
      this._events.shift()
    }
    this._events.push({
      ...event,
      timestamp: performance.now() * 1000,
    })
  }

  /** Get all recorded events */
  get events(): readonly EffectEvent[] {
    return this._events
  }

  /** Get events for a specific effect tag */
  forTag(tag: string): EffectEvent[] {
    return this._events.filter((e) => e.tag === tag)
  }

  /** Get events of a specific type */
  forType(type: EffectEvent['type']): EffectEvent[] {
    return this._events.filter((e) => e.type === type)
  }

  /** Clear all events */
  clear(): void {
    this._events = []
  }

  /** Pause recording */
  pause(): void {
    this._active = false
  }

  /** Resume recording */
  resume(): void {
    this._active = true
  }

  /** Whether recording is active */
  get active(): boolean {
    return this._active
  }

  /** Number of recorded events */
  get count(): number {
    return this._events.length
  }

  /** Export as JSON for external analysis */
  toJSON(): string {
    return JSON.stringify(this._events, null, 2)
  }

  /**
   * Generate a summary of the trace.
   */
  summary(): TraceSummary {
    const tagCounts = new Map<string, number>()
    const tagDurations = new Map<string, number[]>()
    let totalPerforms = 0
    let totalResumes = 0
    let totalErrors = 0

    for (const event of this._events) {
      tagCounts.set(event.tag, (tagCounts.get(event.tag) ?? 0) + 1)

      if (event.type === 'perform') totalPerforms++
      if (event.type === 'resume') totalResumes++
      if (event.type === 'error') totalErrors++

      if (event.duration !== undefined) {
        const durations = tagDurations.get(event.tag) ?? []
        durations.push(event.duration)
        tagDurations.set(event.tag, durations)
      }
    }

    const effectStats: EffectStat[] = []
    for (const [tag, count] of tagCounts) {
      const durations = tagDurations.get(tag) ?? []
      const avgDuration = durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0

      effectStats.push({
        tag,
        count,
        avgDurationUs: avgDuration,
        minDurationUs: durations.length > 0 ? Math.min(...durations) : 0,
        maxDurationUs: durations.length > 0 ? Math.max(...durations) : 0,
      })
    }

    return {
      totalEvents: this._events.length,
      totalPerforms,
      totalResumes,
      totalErrors,
      effectStats: effectStats.sort((a, b) => b.count - a.count),
      durationMs: this._events.length > 0
        ? (this._events[this._events.length - 1]!.timestamp - this._events[0]!.timestamp) / 1000
        : 0,
    }
  }
}

export interface TraceSummary {
  readonly totalEvents: number
  readonly totalPerforms: number
  readonly totalResumes: number
  readonly totalErrors: number
  readonly effectStats: EffectStat[]
  readonly durationMs: number
}

export interface EffectStat {
  readonly tag: string
  readonly count: number
  readonly avgDurationUs: number
  readonly minDurationUs: number
  readonly maxDurationUs: number
}

// ============================================================================
// Effect Inspector — Tracing Handler Wrapper
// ============================================================================

/**
 * Wrap a handler with tracing — records every perform/resume in a trace.
 *
 * @example
 * ```typescript
 * const trace = new EffectTrace()
 * const tracedHandler = inspect(logHandler, trace)
 *
 * run(() => handle(tracedHandler, myComputation))
 *
 * console.log(trace.summary())
 * ```
 */
export function inspect<E extends EffectSignal>(
  handler: Handler<E>,
  trace: EffectTrace,
  handlerName?: string,
): Handler<E> {
  const name = handlerName ?? `handler(${[...handler.tags].join(',')})`

  return {
    tags: handler.tags,
    handles: handler.handles.bind(handler),
    handle(effect: E, resume: (value: EffectReturn<E>) => void) {
      const startTime = performance.now() * 1000

      trace.record({
        type: 'perform',
        tag: effect._tag,
        effect,
        depth: 0,
        handlerName: name,
      })

      handler.handle(effect, (value: EffectReturn<E>) => {
        const duration = performance.now() * 1000 - startTime

        trace.record({
          type: 'resume',
          tag: effect._tag,
          effect,
          duration,
          resumeValue: value,
          depth: 0,
          handlerName: name,
        })

        resume(value)
      })
    },
  }
}

// ============================================================================
// Performance Profiler
// ============================================================================

/**
 * Performance profile for a computation.
 */
export interface PerformanceProfile {
  /** Total execution time in milliseconds */
  readonly totalMs: number
  /** Time spent in handler callbacks in milliseconds */
  readonly handlerMs: number
  /** Time spent in computation (non-handler) in milliseconds */
  readonly computeMs: number
  /** Number of effect performs */
  readonly performCount: number
  /** Number of handler resumes */
  readonly resumeCount: number
  /** Per-effect breakdown */
  readonly effects: Map<string, EffectProfile>
  /** Handler overhead percentage */
  readonly overheadPercent: number
}

export interface EffectProfile {
  readonly tag: string
  readonly count: number
  readonly totalMs: number
  readonly avgMs: number
  readonly minMs: number
  readonly maxMs: number
}

/**
 * Profile a computation's effect handling performance.
 *
 * @example
 * ```typescript
 * const profile = profileComputation(handler, function* () {
 *   for (let i = 0; i < 1000; i++) {
 *     yield* perform<LogEffect>({ _tag: 'Log', msg: `${i}` })
 *   }
 *   return 'done'
 * })
 *
 * console.log(`Total: ${profile.totalMs}ms`)
 * console.log(`Handler overhead: ${profile.overheadPercent}%`)
 * ```
 */
export function profileComputation<T, E extends EffectSignal>(
  handler: Handler<E>,
  computation: () => Eff<T, E>,
): { result: T; profile: PerformanceProfile } {
  const effectTimings = new Map<string, number[]>()
  let performCount = 0
  let resumeCount = 0
  let totalHandlerTime = 0

  const totalStart = performance.now()

  // Drive computation with profiling
  const gen = computation()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)
    if (step.done) {
      const totalMs = performance.now() - totalStart
      const handlerMs = totalHandlerTime
      const computeMs = totalMs - handlerMs

      // Build per-effect profiles
      const effects = new Map<string, EffectProfile>()
      for (const [tag, timings] of effectTimings) {
        const total = timings.reduce((a, b) => a + b, 0)
        effects.set(tag, {
          tag,
          count: timings.length,
          totalMs: total,
          avgMs: total / timings.length,
          minMs: Math.min(...timings),
          maxMs: Math.max(...timings),
        })
      }

      return {
        result: step.value,
        profile: {
          totalMs,
          handlerMs,
          computeMs,
          performCount,
          resumeCount,
          effects,
          overheadPercent: totalMs > 0 ? (handlerMs / totalMs) * 100 : 0,
        },
      }
    }

    const effect = step.value as EffectSignal

    if (handler.handles(effect)) {
      performCount++
      const handlerStart = performance.now()

      let resumeValue: any
      handler.handle(effect as E, (value: EffectReturn<E>) => {
        resumeCount++
        resumeValue = value
      })

      const handlerDuration = performance.now() - handlerStart
      totalHandlerTime += handlerDuration

      const timings = effectTimings.get(effect._tag) ?? []
      timings.push(handlerDuration)
      effectTimings.set(effect._tag, timings)

      input = resumeValue
    } else {
      throw new Error(`fx: Unhandled effect "${effect._tag}" in profiler.`)
    }
  }
}

// ============================================================================
// Handler Stack Inspector
// ============================================================================

/**
 * A snapshot of the handler stack at a point in time.
 */
export interface HandlerStackSnapshot {
  readonly handlers: {
    readonly name: string
    readonly tags: readonly string[]
    readonly depth: number
  }[]
  readonly depth: number
  readonly timestamp: number
}

/**
 * Track the handler stack for debugging.
 */
export class HandlerStackTracker {
  private _stack: { name: string; tags: ReadonlySet<string> }[] = []

  push(handler: Handler<any>, name?: string): void {
    this._stack.push({
      name: name ?? `handler(${[...handler.tags].join(',')})`,
      tags: handler.tags,
    })
  }

  pop(): void {
    this._stack.pop()
  }

  snapshot(): HandlerStackSnapshot {
    return {
      handlers: this._stack.map((h, i) => ({
        name: h.name,
        tags: [...h.tags],
        depth: i,
      })),
      depth: this._stack.length,
      timestamp: performance.now(),
    }
  }

  /**
   * Find which handler handles a given effect tag.
   */
  findHandler(tag: string): string | undefined {
    for (let i = this._stack.length - 1; i >= 0; i--) {
      if (this._stack[i]!.tags.has(tag)) {
        return this._stack[i]!.name
      }
    }
    return undefined
  }

  get depth(): number {
    return this._stack.length
  }
}

// ============================================================================
// Effect Flow Visualizer — Text-based
// ============================================================================

/**
 * Generate a text-based visualization of an effect trace.
 *
 * @example
 * ```
 * ┌─ perform Log "starting"
 * │  └─ resume (void) [0.01ms]
 * ┌─ perform Fetch "/api/users"
 * │  └─ resume ({...}) [45.2ms]
 * ┌─ perform Log "done"
 * │  └─ resume (void) [0.01ms]
 * ```
 */
export function visualizeTrace(trace: EffectTrace): string {
  const lines: string[] = []

  for (const event of trace.events) {
    if (event.type === 'perform') {
      lines.push(`┌─ perform ${event.tag} ${formatEffectPayload(event.effect)}`)
    } else if (event.type === 'resume') {
      const duration = event.duration ? `[${(event.duration / 1000).toFixed(2)}ms]` : ''
      const value = formatResumeValue(event.resumeValue)
      lines.push(`│  └─ resume (${value}) ${duration}`)
    } else if (event.type === 'error') {
      lines.push(`│  ✗ ERROR in ${event.tag}: ${event.effect}`)
    } else if (event.type === 'unhandled') {
      lines.push(`│  ⚠ UNHANDLED: ${event.tag}`)
    }
  }

  return lines.join('\n')
}

function formatEffectPayload(effect: EffectSignal): string {
  const entries = Object.entries(effect).filter(([k]) => k !== '_tag' && k !== '_Return')
  if (entries.length === 0) return ''
  const formatted = entries.map(([k, v]) => {
    if (typeof v === 'string') return `"${v.slice(0, 50)}"`
    if (typeof v === 'number') return String(v)
    if (typeof v === 'function') return '[fn]'
    return JSON.stringify(v)?.slice(0, 50) ?? String(v)
  })
  return formatted.join(', ')
}

function formatResumeValue(value: unknown): string {
  if (value === undefined) return 'void'
  if (value === null) return 'null'
  if (typeof value === 'string') return `"${value.slice(0, 30)}"`
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length} items]`
  if (typeof value === 'object') return `{...}`
  return String(value)
}

// ============================================================================
// Production Monitoring Dashboard Data
// ============================================================================

/**
 * Live monitoring statistics for production.
 */
export class EffectMonitor {
  private _counters = new Map<string, number>()
  private _durations = new Map<string, number[]>()
  private _errors = new Map<string, number>()
  private _startTime = performance.now()
  private _windowSize: number

  constructor(windowSize: number = 1000) {
    this._windowSize = windowSize
  }

  /** Record an effect invocation */
  recordPerform(tag: string, durationMs: number): void {
    this._counters.set(tag, (this._counters.get(tag) ?? 0) + 1)
    const durations = this._durations.get(tag) ?? []
    durations.push(durationMs)
    // Keep only last N entries (sliding window)
    if (durations.length > this._windowSize) durations.shift()
    this._durations.set(tag, durations)
  }

  /** Record an error */
  recordError(tag: string): void {
    this._errors.set(tag, (this._errors.get(tag) ?? 0) + 1)
  }

  /** Get current monitoring stats */
  stats(): MonitoringStats {
    const uptimeMs = performance.now() - this._startTime
    const effects: EffectMonitorStat[] = []

    for (const [tag, count] of this._counters) {
      const durations = this._durations.get(tag) ?? []
      const errors = this._errors.get(tag) ?? 0
      const avgMs = durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0
      const p50 = percentile(durations, 50)
      const p95 = percentile(durations, 95)
      const p99 = percentile(durations, 99)

      effects.push({
        tag,
        totalCount: count,
        errorCount: errors,
        errorRate: count > 0 ? errors / count : 0,
        avgMs,
        p50Ms: p50,
        p95Ms: p95,
        p99Ms: p99,
        throughput: count / (uptimeMs / 1000), // ops/sec
      })
    }

    return {
      uptimeMs,
      totalEffects: Array.from(this._counters.values()).reduce((a, b) => a + b, 0),
      totalErrors: Array.from(this._errors.values()).reduce((a, b) => a + b, 0),
      effects: effects.sort((a, b) => b.totalCount - a.totalCount),
    }
  }

  /** Reset all counters */
  reset(): void {
    this._counters.clear()
    this._durations.clear()
    this._errors.clear()
    this._startTime = performance.now()
  }
}

export interface MonitoringStats {
  readonly uptimeMs: number
  readonly totalEffects: number
  readonly totalErrors: number
  readonly effects: EffectMonitorStat[]
}

export interface EffectMonitorStat {
  readonly tag: string
  readonly totalCount: number
  readonly errorCount: number
  readonly errorRate: number
  readonly avgMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly throughput: number
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)]!
}
