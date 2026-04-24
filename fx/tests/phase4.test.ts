// ============================================================================
// fx-ts — Phase 4 Test Suite: WasmFX & Production Hardening
// ============================================================================

import { describe, it, expect, vi } from 'vitest'
import {
  // Core
  perform,
  createHandler,
  handle,
  run,
  type Eff,
  type Effect,
  type EffectSignal,
  type Handler,

  // Phase 4: Backend Abstraction
  GeneratorBackend,
  WasmFXBackend,
  BackendRegistry,
  backends,
  getBackend,
  selectBackend,
  type Backend,

  // Phase 4: DevTools
  EffectTrace,
  inspect,
  profileComputation,
  HandlerStackTracker,
  visualizeTrace,
  EffectMonitor,

  // Phase 4: Observability
  generateTraceId,
  generateSpanId,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  EffectTracer,
  EffectMetrics,
  instrumentHandler,

  // Phase 4: Benchmarks
  benchmark,
  runCoreBenchmarks,
  formatBenchmarkResults,
  formatBenchmarkMarkdown,
  compareBenchmarks,
  type BenchmarkResult,
} from '../src/index.js'

// ============================================================================
// Test Effect Definitions
// ============================================================================

interface LogEffect extends Effect<'Log', { msg: string }, void> {
  readonly msg: string
}

interface FetchEffect extends Effect<'Fetch', { url: string }, any> {
  readonly url: string
}

// ============================================================================
// PHASE 4: Backend Abstraction Tests
// ============================================================================

describe('Phase 4: Backend Abstraction', () => {
  describe('GeneratorBackend', () => {
    it('should be available in all environments', () => {
      const backend = new GeneratorBackend()
      expect(backend.isAvailable()).toBe(true)
      expect(backend.name).toBe('generator')
      expect(backend.priority).toBe(0)
    })

    it('should run computation with handler', () => {
      const backend = new GeneratorBackend()
      const logged: string[] = []

      const handler = createHandler<LogEffect>({
        Log: (e, r) => { logged.push(e.msg); r(undefined) },
      })

      const result = backend.runWithHandler(handler, function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'hello' })
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'world' })
        return 42
      })

      expect(result).toBe(42)
      expect(logged).toEqual(['hello', 'world'])
    })

    it('should run pure computation', () => {
      const backend = new GeneratorBackend()

      const result = backend.runPure(function* () {
        return 99
      })

      expect(result).toBe(99)
    })

    it('should throw on unhandled effect', () => {
      const backend = new GeneratorBackend()
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      expect(() =>
        backend.runWithHandler(handler, function* () {
          yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/' })
          return 1
        } as any),
      ).toThrow('Unhandled effect')
    })

    it('should run async computation', async () => {
      const backend = new GeneratorBackend()

      const handler = createHandler<FetchEffect>({
        Fetch: (e, r) => {
          setTimeout(() => r({ url: e.url, data: 'async' }), 5)
        },
      })

      const result = await backend.runWithHandlerAsync(handler, function* () {
        return yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/api' })
      })

      expect(result).toEqual({ url: '/api', data: 'async' })
    })
  })

  describe('WasmFXBackend', () => {
    it('should not be available (WasmFX not shipped yet)', () => {
      const backend = new WasmFXBackend()
      expect(backend.isAvailable()).toBe(false)
      expect(backend.name).toBe('wasmfx')
      expect(backend.priority).toBe(100)
    })

    it('should throw when trying to run', () => {
      const backend = new WasmFXBackend()
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      expect(() =>
        backend.runWithHandler(handler, function* () {
          return 1
        }),
      ).toThrow('WasmFX backend is not yet available')
    })
  })

  describe('BackendRegistry', () => {
    it('should auto-detect generator as best backend', () => {
      const registry = new BackendRegistry()
      const best = registry.getBest()
      expect(best.name).toBe('generator')
    })

    it('should list available backends', () => {
      const registry = new BackendRegistry()
      const list = registry.list()

      expect(list.length).toBeGreaterThanOrEqual(2)
      expect(list.find((b) => b.name === 'generator')?.available).toBe(true)
      expect(list.find((b) => b.name === 'wasmfx')?.available).toBe(false)
    })

    it('should select backend by name', () => {
      const registry = new BackendRegistry()
      const selected = registry.select('generator')
      expect(selected.name).toBe('generator')
    })

    it('should throw on unavailable backend selection', () => {
      const registry = new BackendRegistry()
      expect(() => registry.select('wasmfx')).toThrow('not available')
    })

    it('should throw on unknown backend', () => {
      const registry = new BackendRegistry()
      expect(() => registry.select('nonexistent')).toThrow('not found')
    })
  })

  describe('Global backend helpers', () => {
    it('getBackend() should return generator', () => {
      expect(getBackend().name).toBe('generator')
    })

    it('selectBackend() should select generator', () => {
      const b = selectBackend('generator')
      expect(b.name).toBe('generator')
    })
  })
})

// ============================================================================
// PHASE 4: DevTools Tests
// ============================================================================

describe('Phase 4: DevTools', () => {
  describe('EffectTrace', () => {
    it('should record events', () => {
      const trace = new EffectTrace()

      trace.record({
        type: 'perform',
        tag: 'Log',
        effect: { _tag: 'Log', msg: 'test' } as LogEffect,
        depth: 0,
      })

      expect(trace.count).toBe(1)
      expect(trace.events[0]?.type).toBe('perform')
      expect(trace.events[0]?.tag).toBe('Log')
    })

    it('should filter by tag', () => {
      const trace = new EffectTrace()

      trace.record({ type: 'perform', tag: 'Log', effect: { _tag: 'Log' } as any, depth: 0 })
      trace.record({ type: 'perform', tag: 'Fetch', effect: { _tag: 'Fetch' } as any, depth: 0 })
      trace.record({ type: 'perform', tag: 'Log', effect: { _tag: 'Log' } as any, depth: 0 })

      expect(trace.forTag('Log').length).toBe(2)
      expect(trace.forTag('Fetch').length).toBe(1)
    })

    it('should support pause/resume', () => {
      const trace = new EffectTrace()

      trace.record({ type: 'perform', tag: 'A', effect: { _tag: 'A' } as any, depth: 0 })
      trace.pause()
      trace.record({ type: 'perform', tag: 'B', effect: { _tag: 'B' } as any, depth: 0 })
      trace.resume()
      trace.record({ type: 'perform', tag: 'C', effect: { _tag: 'C' } as any, depth: 0 })

      expect(trace.count).toBe(2) // A and C, not B
    })

    it('should generate summary', () => {
      const trace = new EffectTrace()

      for (let i = 0; i < 5; i++) {
        trace.record({ type: 'perform', tag: 'Log', effect: { _tag: 'Log' } as any, depth: 0 })
        trace.record({ type: 'resume', tag: 'Log', effect: { _tag: 'Log' } as any, depth: 0, duration: 10 })
      }
      trace.record({ type: 'error', tag: 'Fail', effect: { _tag: 'Fail' } as any, depth: 0 })

      const summary = trace.summary()
      expect(summary.totalPerforms).toBe(5)
      expect(summary.totalResumes).toBe(5)
      expect(summary.totalErrors).toBe(1)
      expect(summary.effectStats.length).toBe(2)
    })

    it('should export to JSON', () => {
      const trace = new EffectTrace()
      trace.record({ type: 'perform', tag: 'X', effect: { _tag: 'X' } as any, depth: 0 })

      const json = trace.toJSON()
      expect(json).toContain('"tag": "X"')
    })

    it('should respect max events (ring buffer)', () => {
      const trace = new EffectTrace(3)

      for (let i = 0; i < 5; i++) {
        trace.record({ type: 'perform', tag: `E${i}`, effect: { _tag: `E${i}` } as any, depth: 0 })
      }

      expect(trace.count).toBe(3)
      expect(trace.events[0]?.tag).toBe('E2')
    })
  })

  describe('inspect (tracing handler)', () => {
    it('should trace effect performs and resumes', () => {
      const trace = new EffectTrace()
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      const traced = inspect(handler, trace, 'LogHandler')

      run(function* () {
        return yield* handle(traced, function* () {
          yield* perform<LogEffect>({ _tag: 'Log', msg: 'hello' })
          yield* perform<LogEffect>({ _tag: 'Log', msg: 'world' })
          return 'done'
        })
      })

      expect(trace.count).toBe(4) // 2 performs + 2 resumes
      expect(trace.forType('perform').length).toBe(2)
      expect(trace.forType('resume').length).toBe(2)
    })
  })

  describe('profileComputation', () => {
    it('should profile handler performance', () => {
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      const { result, profile } = profileComputation(handler, function* () {
        for (let i = 0; i < 5; i++) {
          yield* perform<LogEffect>({ _tag: 'Log', msg: `${i}` })
        }
        return 42
      })

      expect(result).toBe(42)
      expect(profile.performCount).toBe(5)
      expect(profile.resumeCount).toBe(5)
      expect(profile.totalMs).toBeGreaterThanOrEqual(0)
      expect(profile.effects.has('Log')).toBe(true)
      expect(profile.effects.get('Log')?.count).toBe(5)
    })
  })

  describe('HandlerStackTracker', () => {
    it('should track handler stack', () => {
      const tracker = new HandlerStackTracker()
      const h1 = createHandler<LogEffect>({ Log: (e, r) => r(undefined) })
      const h2 = createHandler<FetchEffect>({ Fetch: (e, r) => r({}) })

      tracker.push(h1, 'LogHandler')
      tracker.push(h2, 'FetchHandler')

      expect(tracker.depth).toBe(2)

      const snapshot = tracker.snapshot()
      expect(snapshot.depth).toBe(2)
      expect(snapshot.handlers[0]?.name).toBe('LogHandler')
      expect(snapshot.handlers[1]?.name).toBe('FetchHandler')

      expect(tracker.findHandler('Log')).toBe('LogHandler')
      expect(tracker.findHandler('Fetch')).toBe('FetchHandler')
      expect(tracker.findHandler('Unknown')).toBeUndefined()

      tracker.pop()
      expect(tracker.depth).toBe(1)
    })
  })

  describe('visualizeTrace', () => {
    it('should generate text visualization', () => {
      const trace = new EffectTrace()

      trace.record({
        type: 'perform',
        tag: 'Log',
        effect: { _tag: 'Log', msg: 'hello' } as LogEffect,
        depth: 0,
      })
      trace.record({
        type: 'resume',
        tag: 'Log',
        effect: { _tag: 'Log', msg: 'hello' } as LogEffect,
        depth: 0,
        duration: 15,
        resumeValue: undefined,
      })

      const viz = visualizeTrace(trace)
      expect(viz).toContain('perform Log')
      expect(viz).toContain('resume')
      expect(viz).toContain('void')
    })
  })

  describe('EffectMonitor', () => {
    it('should track effect performance', () => {
      const monitor = new EffectMonitor()

      for (let i = 0; i < 100; i++) {
        monitor.recordPerform('Log', Math.random() * 10)
      }
      monitor.recordError('Log')

      const stats = monitor.stats()
      expect(stats.totalEffects).toBe(100)
      expect(stats.totalErrors).toBe(1)
      expect(stats.effects.length).toBe(1)
      expect(stats.effects[0]?.tag).toBe('Log')
      expect(stats.effects[0]?.errorRate).toBeCloseTo(0.01)
      expect(stats.effects[0]?.p50Ms).toBeGreaterThanOrEqual(0)
      expect(stats.effects[0]?.p95Ms).toBeGreaterThanOrEqual(0)
    })

    it('should reset stats', () => {
      const monitor = new EffectMonitor()
      monitor.recordPerform('X', 1)
      monitor.reset()

      expect(monitor.stats().totalEffects).toBe(0)
    })
  })
})

// ============================================================================
// PHASE 4: Observability (OpenTelemetry) Tests
// ============================================================================

describe('Phase 4: Observability (OpenTelemetry)', () => {
  describe('Trace/Span ID generation', () => {
    it('should generate valid trace IDs', () => {
      const id = generateTraceId()
      expect(id).toHaveLength(32) // 128-bit hex
      expect(id).toMatch(/^[0-9a-f]{32}$/)
    })

    it('should generate unique trace IDs', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        ids.add(generateTraceId())
      }
      expect(ids.size).toBe(100)
    })

    it('should generate valid span IDs', () => {
      const id = generateSpanId()
      expect(id).toHaveLength(16) // 64-bit hex
      expect(id).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('InMemorySpanExporter', () => {
    it('should collect exported spans', async () => {
      const exporter = new InMemorySpanExporter()

      await exporter.export([{
        traceId: generateTraceId(),
        spanId: generateSpanId(),
        name: 'test-span',
        kind: 'INTERNAL',
        startTime: 1,
        endTime: 2,
        attributes: { 'fx.effect.tag': 'Test' },
        events: [],
        status: { code: 'OK' },
        resource: { 'service.name': 'test' },
      }])

      expect(exporter.spans.length).toBe(1)
      expect(exporter.spans[0]?.name).toBe('test-span')

      exporter.clear()
      expect(exporter.spans.length).toBe(0)
    })
  })

  describe('EffectTracer', () => {
    it('should create traced handler that produces spans', async () => {
      const exporter = new InMemorySpanExporter()
      const tracer = new EffectTracer({
        serviceName: 'test-app',
        exporter,
      })

      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      const traced = tracer.wrap(handler, 'LogHandler')

      run(function* () {
        return yield* handle(traced, function* () {
          yield* perform<LogEffect>({ _tag: 'Log', msg: 'traced!' })
          return 'done'
        })
      })

      await tracer.flush()

      expect(exporter.spans.length).toBe(1)
      expect(exporter.spans[0]?.name).toBe('effect:Log')
      expect(exporter.spans[0]?.status.code).toBe('OK')
      expect(exporter.spans[0]?.attributes['fx.effect.tag']).toBe('Log')
      expect(exporter.spans[0]?.attributes['fx.handler.name']).toBe('LogHandler')
      expect(exporter.spans[0]?.resource['service.name']).toBe('test-app')

      await tracer.shutdown()
    })

    it('should record errors', async () => {
      const exporter = new InMemorySpanExporter()
      const tracer = new EffectTracer({
        serviceName: 'test-app',
        exporter,
      })

      tracer.recordError('Fetch', new Error('connection refused'))
      await tracer.flush()

      expect(exporter.spans.length).toBe(1)
      expect(exporter.spans[0]?.status.code).toBe('ERROR')
      expect(exporter.spans[0]?.events[0]?.name).toBe('exception')

      await tracer.shutdown()
    })

    it('should generate fresh trace IDs', () => {
      const exporter = new InMemorySpanExporter()
      const tracer = new EffectTracer({
        serviceName: 'test',
        exporter,
      })

      const t1 = tracer.startTrace()
      const t2 = tracer.startTrace()

      expect(t1).not.toBe(t2)
    })
  })

  describe('EffectMetrics', () => {
    it('should track counters', () => {
      const metrics = new EffectMetrics()

      metrics.inc('fx_log_total', 1)
      metrics.inc('fx_log_total', 1)
      metrics.inc('fx_log_total', 1)

      const json = metrics.toJSON() as any
      expect(json.counters.fx_log_total).toBe(3)
    })

    it('should track histograms', () => {
      const metrics = new EffectMetrics()

      metrics.observe('fx_duration_ms', 1)
      metrics.observe('fx_duration_ms', 5)
      metrics.observe('fx_duration_ms', 10)

      const json = metrics.toJSON() as any
      expect(json.histograms.fx_duration_ms.count).toBe(3)
      expect(json.histograms.fx_duration_ms.sum).toBe(16)
    })

    it('should export Prometheus format', () => {
      const metrics = new EffectMetrics()

      metrics.inc('fx_effect_total', 5)
      metrics.observe('fx_effect_duration_ms', 1.5)
      metrics.gauge('fx_active_handlers', 3)

      const prometheus = metrics.toPrometheus()
      expect(prometheus).toContain('# TYPE fx_effect_total counter')
      expect(prometheus).toContain('fx_effect_total 5')
      expect(prometheus).toContain('# TYPE fx_effect_duration_ms histogram')
      expect(prometheus).toContain('# TYPE fx_active_handlers gauge')
    })

    it('should reset', () => {
      const metrics = new EffectMetrics()
      metrics.inc('x', 1)
      metrics.reset()

      const json = metrics.toJSON() as any
      expect(Object.keys(json.counters).length).toBe(0)
    })
  })

  describe('instrumentHandler', () => {
    it('should record metrics for every effect', () => {
      const metrics = new EffectMetrics()
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      const instrumented = instrumentHandler(handler, metrics)

      run(function* () {
        return yield* handle(instrumented, function* () {
          yield* perform<LogEffect>({ _tag: 'Log', msg: 'a' })
          yield* perform<LogEffect>({ _tag: 'Log', msg: 'b' })
          yield* perform<LogEffect>({ _tag: 'Log', msg: 'c' })
          return 'done'
        })
      })

      const json = metrics.toJSON() as any
      expect(json.counters['fx_effect_total{tag="Log"}']).toBe(3)
      expect(json.histograms['fx_effect_duration_ms{tag="Log"}'].count).toBe(3)
    })
  })
})

// ============================================================================
// PHASE 4: Benchmark Suite Tests
// ============================================================================

describe('Phase 4: Benchmark Suite', () => {
  describe('benchmark()', () => {
    it('should run a benchmark and return results', () => {
      const result = benchmark('test-bench', () => {
        let sum = 0
        for (let i = 0; i < 100; i++) sum += i
      }, { iterations: 1000, warmup: 100, samples: 3 })

      expect(result.name).toBe('test-bench')
      expect(result.iterations).toBe(1000)
      expect(result.totalMs).toBeGreaterThan(0)
      expect(result.avgMs).toBeGreaterThan(0)
      expect(result.opsPerSecond).toBeGreaterThan(0)
      expect(result.samples.length).toBe(3)
    })
  })

  describe('runCoreBenchmarks', () => {
    it('should run all core benchmarks', () => {
      const suite = runCoreBenchmarks(100) // Small iteration count for test speed

      expect(suite.name).toBe('fx-ts Core Benchmarks')
      expect(suite.results.length).toBe(10)
      expect(suite.timestamp).toBeGreaterThan(0)

      // Every benchmark should have valid results
      for (const r of suite.results) {
        expect(r.name).toBeTruthy()
        expect(r.opsPerSecond).toBeGreaterThan(0)
      }
    })
  })

  describe('formatBenchmarkResults', () => {
    it('should format results as a table', () => {
      const suite = runCoreBenchmarks(50)
      const table = formatBenchmarkResults(suite)

      expect(table).toContain('fx-ts Core Benchmarks')
      expect(table).toContain('ops/sec')
      expect(table).toContain('avg(ms)')
    })
  })

  describe('formatBenchmarkMarkdown', () => {
    it('should format results as Markdown', () => {
      const suite = runCoreBenchmarks(50)
      const md = formatBenchmarkMarkdown(suite)

      expect(md).toContain('##')
      expect(md).toContain('| Benchmark')
      expect(md).toContain('ops/sec')
    })
  })

  describe('compareBenchmarks', () => {
    it('should compare two benchmark results', () => {
      const a: BenchmarkResult = {
        name: 'baseline',
        iterations: 1000,
        totalMs: 10,
        avgMs: 0.01,
        opsPerSecond: 100_000,
        marginOfError: 1,
        samples: [10],
      }

      const b: BenchmarkResult = {
        name: 'optimized',
        iterations: 1000,
        totalMs: 5,
        avgMs: 0.005,
        opsPerSecond: 200_000,
        marginOfError: 1,
        samples: [5],
      }

      const comparison = compareBenchmarks(a, b)
      expect(comparison).toContain('+100.0%')
      expect(comparison).toContain('optimized vs baseline')
    })
  })
})
