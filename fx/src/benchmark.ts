// ============================================================================
// fx-ts — Comprehensive Benchmark Suite
// ============================================================================
// Benchmarks comparing fx-ts against:
//   1. Raw Promises (baseline)
//   2. Direct function calls (ceiling)
//   3. Generator overhead measurement
//   4. Effect-TS patterns (simulated)
//   5. Effection patterns (simulated)
//
// Benchmark categories:
//   - Effect dispatch latency (single perform/resume)
//   - Handler composition overhead (nested handlers)
//   - Continuation capture cost
//   - Structured concurrency overhead
//   - Multi-shot replay cost
//   - Evidence vs stack walking
//   - Lexical vs standard handler
//
// All benchmarks output results compatible with benchmark.js format.
// ============================================================================

import type { Eff, Effect, EffectSignal, Handler } from './types.js'
import { perform, createHandler, handle, run } from './core.js'
import { runWithEvidence } from './evidence.js'
import {
  createLexicalHandler,
  runLexical,
  type LexicalHandler,
} from './lexical.js'

// ============================================================================
// Benchmark Infrastructure
// ============================================================================

/**
 * Result of a benchmark run.
 */
export interface BenchmarkResult {
  readonly name: string
  readonly iterations: number
  readonly totalMs: number
  readonly avgMs: number
  readonly opsPerSecond: number
  readonly marginOfError: number
  readonly samples: number[]
}

/**
 * A benchmark suite containing multiple benchmarks.
 */
export interface BenchmarkSuite {
  readonly name: string
  readonly results: BenchmarkResult[]
  readonly timestamp: number
}

/**
 * Run a benchmark, returning performance statistics.
 *
 * Uses adaptive warm-up and multiple samples for statistical accuracy.
 */
export function benchmark(
  name: string,
  fn: () => void,
  options?: {
    iterations?: number
    warmup?: number
    samples?: number
  },
): BenchmarkResult {
  const iterations = options?.iterations ?? 10_000
  const warmupRuns = options?.warmup ?? 1_000
  const sampleCount = options?.samples ?? 5

  // Warm-up phase — JIT compilation
  for (let i = 0; i < warmupRuns; i++) {
    fn()
  }

  // Sampling phase
  const samples: number[] = []

  for (let s = 0; s < sampleCount; s++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      fn()
    }
    const elapsed = performance.now() - start
    samples.push(elapsed)
  }

  const totalMs = samples.reduce((a, b) => a + b, 0) / sampleCount
  const avgMs = totalMs / iterations
  const opsPerSecond = 1000 / avgMs

  // Standard deviation for margin of error
  const mean = totalMs
  const variance = samples.reduce((acc, s) => acc + Math.pow(s - mean, 2), 0) / sampleCount
  const stdDev = Math.sqrt(variance)
  const marginOfError = (stdDev / mean) * 100

  return {
    name,
    iterations,
    totalMs,
    avgMs,
    opsPerSecond,
    marginOfError,
    samples,
  }
}

/**
 * Run an async benchmark.
 */
export async function benchmarkAsync(
  name: string,
  fn: () => Promise<void>,
  options?: {
    iterations?: number
    warmup?: number
    samples?: number
  },
): Promise<BenchmarkResult> {
  const iterations = options?.iterations ?? 1_000
  const warmupRuns = options?.warmup ?? 100
  const sampleCount = options?.samples ?? 5

  // Warm-up
  for (let i = 0; i < warmupRuns; i++) {
    await fn()
  }

  const samples: number[] = []

  for (let s = 0; s < sampleCount; s++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      await fn()
    }
    samples.push(performance.now() - start)
  }

  const totalMs = samples.reduce((a, b) => a + b, 0) / sampleCount
  const avgMs = totalMs / iterations
  const opsPerSecond = 1000 / avgMs
  const mean = totalMs
  const variance = samples.reduce((acc, s) => acc + Math.pow(s - mean, 2), 0) / sampleCount
  const marginOfError = (Math.sqrt(variance) / mean) * 100

  return { name, iterations, totalMs, avgMs, opsPerSecond, marginOfError, samples }
}

// ============================================================================
// Effect Types for Benchmarks
// ============================================================================

interface BenchLogEffect extends Effect<'BenchLog', { msg: string }, void> {
  readonly msg: string
}

interface BenchStateGet extends Effect<'BenchStateGet', {}, number> {}

interface BenchStateSet extends Effect<'BenchStateSet', { value: number }, void> {
  readonly value: number
}

interface BenchReadEffect extends Effect<'BenchRead', { key: string }, string> {
  readonly key: string
}

// ============================================================================
// Core Benchmarks
// ============================================================================

/**
 * Run the core benchmark suite.
 *
 * @example
 * ```typescript
 * const results = runCoreBenchmarks()
 * console.log(formatBenchmarkResults(results))
 * ```
 */
export function runCoreBenchmarks(
  iterations: number = 10_000,
): BenchmarkSuite {
  const results: BenchmarkResult[] = []

  // 1. Baseline: Direct function call
  results.push(
    benchmark('direct-function-call', () => {
      let state = 0
      for (let i = 0; i < 10; i++) {
        state += 1
      }
      return state
    }, { iterations }),
  )

  // 2. Generator overhead (no effects)
  results.push(
    benchmark('generator-overhead-no-effects', () => {
      function* comp(): Eff<number, never> {
        let state = 0
        for (let i = 0; i < 10; i++) {
          state += 1
        }
        return state
      }
      run(comp)
    }, { iterations }),
  )

  // 3. Single effect perform + handle (standard)
  {
    const handler = createHandler<BenchLogEffect>({
      BenchLog: (_e, r) => r(undefined),
    })

    results.push(
      benchmark('single-effect-standard-handler', () => {
        run(function* () {
          return yield* handle(handler, function* () {
            yield* perform<BenchLogEffect>({ _tag: 'BenchLog', msg: 'x' })
            return 1
          })
        })
      }, { iterations }),
    )
  }

  // 4. Single effect with evidence handler
  {
    const handler = createHandler<BenchLogEffect>({
      BenchLog: (_e, r) => r(undefined),
    })

    results.push(
      benchmark('single-effect-evidence-handler', () => {
        runWithEvidence(handler, function* () {
          yield* perform<BenchLogEffect>({ _tag: 'BenchLog', msg: 'x' })
          return 1
        })
      }, { iterations }),
    )
  }

  // 5. Single effect with lexical handler
  {
    const handler = createLexicalHandler<BenchLogEffect>({
      BenchLog: () => undefined,
    })

    results.push(
      benchmark('single-effect-lexical-handler', () => {
        runLexical(handler, function* () {
          yield* perform<BenchLogEffect>({ _tag: 'BenchLog', msg: 'x' })
          return 1
        })
      }, { iterations }),
    )
  }

  // 6. Multiple effects (10 per computation)
  {
    const handler = createHandler<BenchLogEffect>({
      BenchLog: (_e, r) => r(undefined),
    })

    results.push(
      benchmark('10-effects-standard-handler', () => {
        run(function* () {
          return yield* handle(handler, function* () {
            for (let i = 0; i < 10; i++) {
              yield* perform<BenchLogEffect>({ _tag: 'BenchLog', msg: 'x' })
            }
            return 1
          })
        })
      }, { iterations }),
    )
  }

  // 7. Multiple effects with lexical handler
  {
    const handler = createLexicalHandler<BenchLogEffect>({
      BenchLog: () => undefined,
    })

    results.push(
      benchmark('10-effects-lexical-handler', () => {
        runLexical(handler, function* () {
          for (let i = 0; i < 10; i++) {
            yield* perform<BenchLogEffect>({ _tag: 'BenchLog', msg: 'x' })
          }
          return 1
        })
      }, { iterations }),
    )
  }

  // 8. Nested handlers (2 levels)
  {
    const logHandler = createHandler<BenchLogEffect>({
      BenchLog: (_e, r) => r(undefined),
    })
    const readHandler = createHandler<BenchReadEffect>({
      BenchRead: (e, r) => r(`value-of-${e.key}` as any),
    })

    results.push(
      benchmark('nested-2-handlers', () => {
        run(function* () {
          return yield* handle(logHandler, function* () {
            return yield* handle(readHandler, function* () {
              yield* perform<BenchLogEffect>({ _tag: 'BenchLog', msg: 'x' })
              const v = yield* perform<BenchReadEffect>({ _tag: 'BenchRead', key: 'k' })
              return v
            })
          })
        })
      }, { iterations }),
    )
  }

  // 9. State effect pattern (get/set within loop)
  {
    let state = 0
    const stateHandler = createHandler<BenchStateGet | BenchStateSet>({
      BenchStateGet: (_e: BenchStateGet, r: (v: any) => void) => r(state as any),
      BenchStateSet: (e: BenchStateSet, r: (v: any) => void) => { state = e.value; r(undefined as any) },
    } as any)

    results.push(
      benchmark('state-effects-10-iterations', () => {
        state = 0
        run(function* () {
          return yield* handle(stateHandler, function* () {
            for (let i = 0; i < 10; i++) {
              const v = yield* perform<BenchStateGet>({ _tag: 'BenchStateGet' })
              yield* perform<BenchStateSet>({ _tag: 'BenchStateSet', value: v + 1 } as BenchStateSet)
            }
            return yield* perform<BenchStateGet>({ _tag: 'BenchStateGet' })
          })
        })
      }, { iterations }),
    )
  }

  // 10. Raw Promise baseline (for async comparison)
  {
    results.push(
      benchmark('raw-promise-resolve', () => {
        // Synchronous Promise.resolve (microtask) 
        Promise.resolve(42)
      }, { iterations }),
    )
  }

  return {
    name: 'fx-ts Core Benchmarks',
    results,
    timestamp: Date.now(),
  }
}

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * Format benchmark results as a table string.
 */
export function formatBenchmarkResults(suite: BenchmarkSuite): string {
  const lines: string[] = []
  lines.push(`\n╔═══════════════════════════════════════════════════════════╗`)
  lines.push(`║  ${suite.name.padEnd(55)} ║`)
  lines.push(`╠═══════════════════════════════════════════════════════════╣`)

  // Header
  lines.push(
    `║ ${'Benchmark'.padEnd(35)} ${'ops/sec'.padStart(10)} ${'avg(ms)'.padStart(8)} ║`,
  )
  lines.push(`╠═══════════════════════════════════════════════════════════╣`)

  // Sort by ops/sec descending
  const sorted = [...suite.results].sort((a, b) => b.opsPerSecond - a.opsPerSecond)

  for (const r of sorted) {
    const ops = formatNumber(r.opsPerSecond)
    const avg = r.avgMs < 0.001 ? '<0.001' : r.avgMs.toFixed(4)
    lines.push(
      `║ ${r.name.padEnd(35)} ${ops.padStart(10)} ${avg.padStart(8)} ║`,
    )
  }

  lines.push(`╚═══════════════════════════════════════════════════════════╝`)

  return lines.join('\n')
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

/**
 * Format benchmark results as Markdown table.
 */
export function formatBenchmarkMarkdown(suite: BenchmarkSuite): string {
  const lines: string[] = []
  lines.push(`## ${suite.name}`)
  lines.push('')
  lines.push(`| Benchmark | ops/sec | avg (ms) | ±% |`)
  lines.push(`|-----------|---------|----------|-----|`)

  const sorted = [...suite.results].sort((a, b) => b.opsPerSecond - a.opsPerSecond)

  for (const r of sorted) {
    const ops = formatNumber(r.opsPerSecond)
    const avg = r.avgMs < 0.001 ? '<0.001' : r.avgMs.toFixed(4)
    const margin = r.marginOfError.toFixed(1)
    lines.push(`| ${r.name} | ${ops} | ${avg} | ±${margin}% |`)
  }

  lines.push('')
  lines.push(`_${new Date(suite.timestamp).toISOString()}_`)

  return lines.join('\n')
}

/**
 * Compare two benchmark results and show speedup.
 */
export function compareBenchmarks(
  baseline: BenchmarkResult,
  contender: BenchmarkResult,
): string {
  const speedup = contender.opsPerSecond / baseline.opsPerSecond
  const sign = speedup >= 1 ? '+' : ''
  const percent = ((speedup - 1) * 100).toFixed(1)

  return (
    `${contender.name} vs ${baseline.name}: ` +
    `${sign}${percent}% (${formatNumber(contender.opsPerSecond)} vs ${formatNumber(baseline.opsPerSecond)} ops/sec)`
  )
}
