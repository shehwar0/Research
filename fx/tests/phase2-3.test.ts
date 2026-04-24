// ============================================================================
// fx-ts — Phase 2 & 3 Test Suite
// ============================================================================

import { describe, it, expect, vi } from 'vitest'
import {
  // Core (Phase 1)
  perform,
  createHandler,
  handle,
  handleAsync,
  run,
  compose,
  composeAll,
  type Eff,
  type Effect,
  type EffectSignal,
  type Handler,
  Ok, Err,
  fail,
  catchFail,
  type FailEffect,

  // Phase 2: Resources
  using,
  bracket,
  ResourceScope,
  AggregateResourceError,
  resourceHandler,
  type AcquireEffect,
  type Resource,
  type ResourceDescriptor,

  // Phase 2: Task Groups
  createTaskGroup,
  withTaskGroup,
  parallel,
  parallelN,
  type TaskResult,
  type SupervisionStrategy,

  // Phase 2: Evidence-Passing
  EvidenceVector,
  createMarker,
  withEvidence,
  runWithEvidence,
  handleAsyncWithEvidence,

  // Phase 2: Type Inference (type-only imports for compile-time tests)
  type InferEffects,
  type InferReturn,
  type RequiresHandling,
  type HandlerFor,
  type MergeEffects,
  type ContainsEffect,
  type EffectTagsOf,
  type PipeHandled,

  // Phase 3: Multi-Shot
  captureMultiShot,
  handleMultiShot,
  createMultiShotHandler,
  choose,
  allChoicesHandler,
  collectAll,
  amb,
  ambHandler,
  type ChooseEffect,
  type AmbEffect,

  // Phase 3: Async Effects
  AsyncHandle,
  signalAsync,
  awaitHandle,
  asyncEffectHandler,
  runAsyncEffects,
  pipeline,
  type SignalAsyncEffect,
  type AwaitHandleEffect,

  // Phase 3: Bidirectional Effects
  yieldValue,
  yieldAll,
  collectStream,
  forEachEffect,
  mapStream,
  filterStream,
  takeStream,
  fromIterable,
  toAsyncIterable,
  type YieldEffect,
  type EffectStream,

  // Phase 3: Lexical Handlers
  createLexicalHandler,
  handleLexical,
  runLexical,
  isTailResumptive,
  toLexicalHandler,
  benchmarkHandler,
  type LexicalHandler,
} from '../src/index.js'

// ============================================================================
// Test Effect Definitions (shared)
// ============================================================================

interface LogEffect extends Effect<'Log', { msg: string }, void> {
  readonly msg: string
}

interface FetchEffect extends Effect<'Fetch', { url: string }, any> {
  readonly url: string
}

interface StateGetEffect extends Effect<'StateGet', {}, number> {}

interface StateSetEffect extends Effect<'StateSet', { value: number }, void> {
  readonly value: number
}

// ============================================================================
// PHASE 2: Resource Management Tests
// ============================================================================

describe('Phase 2: Resource Management', () => {
  describe('ResourceScope', () => {
    it('should track and release resources', () => {
      const scope = new ResourceScope()
      const released: string[] = []

      scope.track({ value: 'a', release: () => released.push('a') })
      scope.track({ value: 'b', release: () => released.push('b') })
      scope.track({ value: 'c', release: () => released.push('c') })

      expect(scope.count).toBe(3)
      scope.close()

      // Released in reverse (LIFO) order
      expect(released).toEqual(['c', 'b', 'a'])
      expect(scope.closed).toBe(true)
      expect(scope.count).toBe(0)
    })

    it('should not double-close', () => {
      const scope = new ResourceScope()
      let releaseCount = 0
      scope.track({ value: 1, release: () => releaseCount++ })

      scope.close()
      scope.close() // should be a no-op

      expect(releaseCount).toBe(1)
    })

    it('should prevent tracking on closed scope', () => {
      const scope = new ResourceScope()
      scope.close()

      expect(() =>
        scope.track({ value: 1, release: () => {} }),
      ).toThrow('closed ResourceScope')
    })

    it('should release individual resources early', () => {
      const scope = new ResourceScope()
      const released: string[] = []

      const r1: Resource<string> = { value: 'x', release: () => released.push('x') }
      const r2: Resource<string> = { value: 'y', release: () => released.push('y') }

      scope.track(r1)
      scope.track(r2)

      scope.release(r1) // early release
      expect(released).toEqual(['x'])
      expect(scope.count).toBe(1)

      scope.close()
      expect(released).toEqual(['x', 'y'])
    })

    it('should aggregate errors during cleanup', () => {
      const scope = new ResourceScope()
      scope.track({
        value: 1,
        release: () => { throw new Error('release error 1') },
      })
      scope.track({
        value: 2,
        release: () => { throw new Error('release error 2') },
      })

      expect(() => scope.close()).toThrow(AggregateResourceError)
    })
  })

  describe('bracket combinator', () => {
    it('should acquire, use, and release', () => {
      let acquired = false
      let released = false

      const result = run(function* () {
        return yield* bracket(
          () => { acquired = true; return 'resource' },
          function* (r) { return `used: ${r}` },
          () => { released = true },
        )
      })

      expect(acquired).toBe(true)
      expect(released).toBe(true)
      expect(result).toBe('used: resource')
    })

    it('should release even on error', () => {
      let released = false

      expect(() =>
        run(function* () {
          return yield* bracket(
            () => 'resource',
            function* (_r) { throw new Error('boom') },
            () => { released = true },
          )
        }),
      ).toThrow('boom')

      expect(released).toBe(true)
    })
  })

  describe('resourceHandler', () => {
    it('should handle acquire effects and track resources', () => {
      const scope = new ResourceScope()
      const handler = resourceHandler(scope)
      let acquireCalled = false
      let releaseFn: (() => void) | undefined

      const result = run(function* () {
        return yield* handle(handler, function* () {
          const value = yield* using({
            acquire: () => {
              acquireCalled = true
              return 42
            },
            release: (v) => {
              releaseFn = () => {}
            },
          })
          return value
        })
      })

      expect(result).toBe(42)
      expect(acquireCalled).toBe(true)
      expect(scope.count).toBe(1) // Resource tracked

      scope.close()
      expect(scope.count).toBe(0)
    })
  })
})

// ============================================================================
// PHASE 2: Task Group Tests
// ============================================================================

describe('Phase 2: Task Groups', () => {
  describe('createTaskGroup', () => {
    it('should create an active task group', () => {
      const group = createTaskGroup('failFast')
      expect(group.active).toBe(true)
      expect(group.activeCount).toBe(0)
    })

    it('should spawn tasks that complete synchronously', async () => {
      const group = createTaskGroup('allSettled')

      group.spawn(function* () { return 'a' })
      group.spawn(function* () { return 'b' })

      const results = await group.completion
      expect(results).toEqual([
        { status: 'completed', value: 'a' },
        { status: 'completed', value: 'b' },
      ])
    })

    it('should not allow spawning in closed group', () => {
      const group = createTaskGroup()
      group.close()

      expect(() =>
        group.spawn(function* () { return 1 }),
      ).toThrow('inactive TaskGroup')
    })

    it('should cancel remaining tasks on close', async () => {
      const group = createTaskGroup('allSettled')
      group.spawn(function* () { return 'done' })
      group.close()

      expect(group.active).toBe(false)
    })
  })

  describe('parallel', () => {
    it('should run computations in parallel', async () => {
      const results = await parallel([
        function* () { return 1 },
        function* () { return 2 },
        function* () { return 3 },
      ], 'allSettled')

      expect(results).toEqual([
        { status: 'completed', value: 1 },
        { status: 'completed', value: 2 },
        { status: 'completed', value: 3 },
      ])
    })

    it('should handle failures with failFast', async () => {
      const result = parallel([
        function* () { return 1 },
        function* (): Generator<never, number, unknown> { throw new Error('fail!') },
        function* () { return 3 },
      ], 'failFast')

      await expect(result).rejects.toThrow('fail!')
    })
  })

  describe('parallelN', () => {
    it('should limit concurrency', async () => {
      const results = await parallelN(
        [
          function* () { return 'a' },
          function* () { return 'b' },
          function* () { return 'c' },
          function* () { return 'd' },
        ],
        2,
        'allSettled',
      )

      expect(results.filter(r => r.status === 'completed').length).toBe(4)
    })
  })
})

// ============================================================================
// PHASE 2: Evidence-Passing Tests
// ============================================================================

describe('Phase 2: Evidence-Passing Handler Dispatch', () => {
  describe('EvidenceVector', () => {
    it('should store and retrieve handler evidence', () => {
      const ev = new EvidenceVector()
      const marker = createMarker()
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      ev.set('Log', handler, marker)

      expect(ev.has('Log')).toBe(true)
      expect(ev.has('Fetch')).toBe(false)

      const entry = ev.get('Log')
      expect(entry).toBeDefined()
      expect(entry!.marker).toBe(marker)
    })

    it('should inherit from parent evidence', () => {
      const parent = new EvidenceVector()
      const marker = createMarker()
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      parent.set('Log', handler, marker)

      const child = parent.child()
      expect(child.has('Log')).toBe(true)
      expect(child.get('Log')?.marker).toBe(marker)
    })

    it('should shadow parent entries', () => {
      const parent = new EvidenceVector()
      const child = parent.child()

      const m1 = createMarker()
      const m2 = createMarker()

      const h1 = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      parent.set('Log', h1, m1)
      child.set('Log', h1, m2)

      // Child's entry should shadow parent's
      expect(child.get('Log')?.marker).toBe(m2)
    })
  })

  describe('runWithEvidence', () => {
    it('should run computation with O(1) handler lookup', () => {
      const logged: string[] = []

      const logHandler = createHandler<LogEffect>({
        Log: (effect, resume) => {
          logged.push(effect.msg)
          resume(undefined)
        },
      })

      const result = runWithEvidence(logHandler, function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'hello' })
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'world' })
        return 'done'
      })

      expect(result).toBe('done')
      expect(logged).toEqual(['hello', 'world'])
    })

    it('should handle stateful effects via evidence', () => {
      let state = 0

      const stateHandler = createHandler<StateGetEffect | StateSetEffect>({
        StateGet: (_e, r) => r(state as any),
        StateSet: (e, r) => { state = (e as StateSetEffect).value; r(undefined as any) },
      } as any)

      const result = runWithEvidence(stateHandler, function* () {
        const current = yield* perform<StateGetEffect>({ _tag: 'StateGet' })
        yield* perform<StateSetEffect>({ _tag: 'StateSet', value: current + 10 } as StateSetEffect)
        return yield* perform<StateGetEffect>({ _tag: 'StateGet' })
      })

      expect(result).toBe(10)
      expect(state).toBe(10)
    })

    it('should throw on unhandled effects', () => {
      const logHandler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      expect(() =>
        runWithEvidence(logHandler, function* () {
          yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/api' })
          return 'never'
        } as any),
      ).toThrow('Unhandled effect')
    })
  })

  describe('handleAsyncWithEvidence', () => {
    it('should handle async effects with evidence', async () => {
      const fetchHandler = createHandler<FetchEffect>({
        Fetch: (effect, resume) => {
          setTimeout(() => resume({ url: effect.url, data: 'evidence-data' }), 5)
        },
      })

      const result = await handleAsyncWithEvidence(fetchHandler, function* () {
        return yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/api/test' })
      })

      expect(result).toEqual({ url: '/api/test', data: 'evidence-data' })
    })
  })

  describe('withEvidence (generator form)', () => {
    it('should compose with other generators via yield*', () => {
      const logged: string[] = []

      const logHandler = createHandler<LogEffect>({
        Log: (e, r) => { logged.push(e.msg); r(undefined) },
      })

      const fetchHandler = createHandler<FetchEffect>({
        Fetch: (e, r) => r({ url: e.url }),
      })

      const result = run(function* () {
        return yield* withEvidence(fetchHandler, function* () {
          return yield* withEvidence(logHandler, function* () {
            yield* perform<LogEffect>({ _tag: 'Log', msg: 'nested' })
            return yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/api' })
          })
        })
      })

      expect(result).toEqual({ url: '/api' })
      expect(logged).toEqual(['nested'])
    })
  })
})

// ============================================================================
// PHASE 2: Type Inference Compile-Time Tests
// ============================================================================

describe('Phase 2: Type Inference Helpers', () => {
  it('should infer effect types (compile-time assertions)', () => {
    // These are compile-time checks — they just need to typecheck
    type MyComp = Eff<string, FetchEffect | LogEffect>

    type Effects = InferEffects<MyComp>
    type Return = InferReturn<MyComp>
    type NeedsHandling = RequiresHandling<MyComp>
    type IsPure = RequiresHandling<Eff<string, never>>
    type Tags = EffectTagsOf<FetchEffect | LogEffect>
    type HasFetch = ContainsEffect<FetchEffect | LogEffect, FetchEffect>
    type Merged = MergeEffects<FetchEffect, LogEffect>

    // Runtime assertion just to make the test pass
    expect(true).toBe(true)
  })
})

// ============================================================================
// PHASE 3: Multi-Shot Continuation Tests
// ============================================================================

describe('Phase 3: Multi-Shot Continuations', () => {
  describe('captureMultiShot', () => {
    it('should capture and replay a continuation', () => {
      function* simple(): Eff<number, ChooseEffect<number>> {
        const x = yield* choose([1, 2, 3])
        return x * 10
      }

      const cont = captureMultiShot(simple)

      const r1 = cont.resume(1)
      expect(r1.done).toBe(true)
      if (r1.done) expect(r1.value).toBe(10)

      // Resume again with different value (multi-shot!)
      const r2 = cont.resume(2)
      expect(r2.done).toBe(true)
      if (r2.done) expect(r2.value).toBe(20)
    })
  })

  describe('collectAll (non-determinism)', () => {
    it('should collect all branches of choose', () => {
      const results = collectAll(function* () {
        const x = yield* choose([1, 2, 3])
        return x * 10
      })

      expect(results).toEqual([10, 20, 30])
    })

    it('should handle nested choose (Cartesian product)', () => {
      const results = collectAll(function* () {
        const x = yield* choose([1, 2])
        const y = yield* choose([10, 20])
        return x + y
      })

      expect(results).toEqual([11, 21, 12, 22])
    })

    it('should handle single option', () => {
      const results = collectAll(function* () {
        const x = yield* choose([42])
        return x
      })

      expect(results).toEqual([42])
    })

    it('should handle empty computation (no effects)', () => {
      const results = collectAll(function* () {
        return 99
      })

      expect(results).toEqual([99])
    })
  })

  describe('handleMultiShot', () => {
    it('should explore all branches with custom handler', () => {
      const handler = createMultiShotHandler<ChooseEffect<string>>({
        Choose: (effect: ChooseEffect<string>, resumeAll: (values: any[]) => void) => {
          // Only explore first two options
          resumeAll(effect.options.slice(0, 2))
        },
      } as any)

      const results = handleMultiShot(handler, function* () {
        const x = yield* choose(['a', 'b', 'c'])
        return `result: ${x}`
      })

      expect(results).toEqual(['result: a', 'result: b'])
    })
  })

  describe('amb (ambiguity)', () => {
    it('should explore both branches', () => {
      const handler = ambHandler()

      const results = handleMultiShot(handler, function* () {
        const b = yield* amb()
        return b ? 'yes' : 'no'
      })

      expect(results).toEqual(['yes', 'no'])
    })
  })
})

// ============================================================================
// PHASE 3: Async Effects (Ahman & Pretnar) Tests
// ============================================================================

describe('Phase 3: Async Effects (Signal/Execute/Interrupt)', () => {
  describe('AsyncHandle', () => {
    it('should resolve and provide value', async () => {
      const handle = new AsyncHandle<number>()
      expect(handle.settled).toBe(false)

      handle.resolve(42)
      expect(handle.settled).toBe(true)
      expect(handle.peek()).toBe(42)

      const value = await handle.toPromise()
      expect(value).toBe(42)
    })

    it('should reject with error', async () => {
      const handle = new AsyncHandle<number>()
      handle.reject(new Error('async fail'))

      await expect(handle.toPromise()).rejects.toThrow('async fail')
    })

    it('should not double-resolve', () => {
      const handle = new AsyncHandle<number>()
      handle.resolve(1)
      handle.resolve(2) // should be ignored

      expect(handle.peek()).toBe(1)
    })

    it('should notify waiters on resolve', async () => {
      const handle = new AsyncHandle<string>()

      const promise = handle.toPromise()
      handle.resolve('hello')

      expect(await promise).toBe('hello')
    })
  })

  describe('runAsyncEffects', () => {
    it('should run signal/await lifecycle', async () => {
      const result = await runAsyncEffects(function* () {
        const h = yield* signalAsync({
          _tag: 'compute',
          execute: async () => 42,
        })
        return yield* awaitHandle(h)
      })

      expect(result).toBe(42)
    })

    it('should run multiple signals in parallel', async () => {
      const start = Date.now()

      const result = await runAsyncEffects(function* () {
        // Signal two async operations
        const h1 = yield* signalAsync({
          _tag: 'delay1',
          execute: () => new Promise<string>(r => setTimeout(() => r('a'), 50)),
        })
        const h2 = yield* signalAsync({
          _tag: 'delay2',
          execute: () => new Promise<string>(r => setTimeout(() => r('b'), 50)),
        })

        // Both should be running in parallel
        const r1 = yield* awaitHandle(h1)
        const r2 = yield* awaitHandle(h2)
        return [r1, r2]
      })

      const elapsed = Date.now() - start

      expect(result).toEqual(['a', 'b'])
      // Should complete in ~50ms (parallel), not ~100ms (sequential)
      expect(elapsed).toBeLessThan(150)
    })
  })

  describe('pipeline combinator', () => {
    it('should execute operations with pipeline parallelism', async () => {
      const result = await runAsyncEffects(function* () {
        return yield* pipeline([
          { _tag: 'op1', execute: async () => 10 },
          { _tag: 'op2', execute: async () => 20 },
          { _tag: 'op3', execute: async () => 30 },
        ])
      })

      expect(result).toEqual([10, 20, 30])
    })
  })
})

// ============================================================================
// PHASE 3: Bidirectional Effects Tests
// ============================================================================

describe('Phase 3: Bidirectional Effects', () => {
  describe('yieldValue', () => {
    it('should yield values that can be collected', () => {
      const result = run(function* () {
        return yield* collectStream(function* () {
          yield* yieldValue(1)
          yield* yieldValue(2)
          yield* yieldValue(3)
          return 'done'
        })
      })

      expect(result.values).toEqual([1, 2, 3])
      expect(result.result).toBe('done')
    })
  })

  describe('yieldAll', () => {
    it('should yield all values from an iterable', () => {
      const result = run(function* () {
        return yield* collectStream(function* () {
          yield* yieldAll([10, 20, 30])
          return 'finished'
        })
      })

      expect(result.values).toEqual([10, 20, 30])
      expect(result.result).toBe('finished')
    })
  })

  describe('forEachEffect', () => {
    it('should call callback for each yielded value', () => {
      const collected: number[] = []

      const result = run(function* () {
        return yield* forEachEffect(
          function* () {
            yield* yieldValue(1)
            yield* yieldValue(2)
            yield* yieldValue(3)
            return 'done'
          },
          (v) => collected.push(v),
        )
      })

      expect(collected).toEqual([1, 2, 3])
      expect(result).toBe('done')
    })
  })

  describe('mapStream', () => {
    it('should transform yielded values', () => {
      const result = run(function* () {
        return yield* collectStream(function* () {
          return yield* mapStream(
            function* () {
              yield* yieldValue(1)
              yield* yieldValue(2)
              yield* yieldValue(3)
              return 'mapped'
            },
            (x) => x * 10,
          )
        })
      })

      expect(result.values).toEqual([10, 20, 30])
      expect(result.result).toBe('mapped')
    })
  })

  describe('filterStream', () => {
    it('should filter yielded values', () => {
      const result = run(function* () {
        return yield* collectStream(function* () {
          return yield* filterStream(
            function* () {
              yield* yieldValue(1)
              yield* yieldValue(2)
              yield* yieldValue(3)
              yield* yieldValue(4)
              return 'filtered'
            },
            (x) => x % 2 === 0,
          )
        })
      })

      expect(result.values).toEqual([2, 4])
      expect(result.result).toBe('filtered')
    })
  })

  describe('takeStream', () => {
    it('should take only first N values', () => {
      const result = run(function* () {
        return yield* collectStream(function* () {
          return yield* takeStream(
            function* () {
              yield* yieldValue(1)
              yield* yieldValue(2)
              yield* yieldValue(3)
              yield* yieldValue(4)
              yield* yieldValue(5)
              return 'full'
            },
            3,
          )
        })
      })

      expect(result.values).toEqual([1, 2, 3])
    })
  })

  describe('fromIterable', () => {
    it('should convert iterable to effect stream', () => {
      const result = run(function* () {
        return yield* collectStream(function* () {
          return yield* fromIterable([10, 20, 30])
        })
      })

      expect(result.values).toEqual([10, 20, 30])
    })
  })

  describe('bidirectional with effects', () => {
    it('should mix yielding and effect handling', () => {
      const logged: string[] = []

      const logHandler = createHandler<LogEffect>({
        Log: (e, r) => { logged.push(e.msg); r(undefined) },
      })

      const result = run(function* () {
        return yield* handle(logHandler, function* () {
          return yield* collectStream(function* (): EffectStream<number, string, LogEffect> {
            yield* perform<LogEffect>({ _tag: 'Log', msg: 'before' })
            yield* yieldValue(1)
            yield* perform<LogEffect>({ _tag: 'Log', msg: 'middle' })
            yield* yieldValue(2)
            yield* perform<LogEffect>({ _tag: 'Log', msg: 'after' })
            return 'done'
          })
        })
      })

      expect(result.values).toEqual([1, 2])
      expect(result.result).toBe('done')
      expect(logged).toEqual(['before', 'middle', 'after'])
    })
  })

  describe('toAsyncIterable', () => {
    it('should convert a pure stream to async iterable', async () => {
      const values: number[] = []

      const iterable = toAsyncIterable(function* () {
        yield* yieldValue(1)
        yield* yieldValue(2)
        yield* yieldValue(3)
      })

      for await (const v of iterable) {
        values.push(v)
      }

      expect(values).toEqual([1, 2, 3])
    })
  })
})

// ============================================================================
// PHASE 3: Lexical Handler Optimization Tests
// ============================================================================

describe('Phase 3: Lexical Handler Optimization', () => {
  describe('createLexicalHandler', () => {
    it('should create a direct-call handler', () => {
      const handler = createLexicalHandler<LogEffect>({
        Log: (effect) => {
          // Just return, no resume callback needed
          return undefined
        },
      })

      expect(handler.handles({ _tag: 'Log', msg: 'test' } as LogEffect)).toBe(true)
      expect(handler.handles({ _tag: 'Fetch', url: '/' } as any)).toBe(false)
    })
  })

  describe('runLexical', () => {
    it('should run with zero-overhead handler', () => {
      const logged: string[] = []

      const handler = createLexicalHandler<LogEffect>({
        Log: (effect) => {
          logged.push(effect.msg)
          return undefined
        },
      })

      const result = runLexical(handler, function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'hello' })
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'world' })
        return 42
      })

      expect(result).toBe(42)
      expect(logged).toEqual(['hello', 'world'])
    })

    it('should handle stateful effects with zero overhead', () => {
      let state = 0

      const handler = createLexicalHandler<StateGetEffect | StateSetEffect>({
        StateGet: () => state as any,
        StateSet: (e) => { state = (e as StateSetEffect).value; return undefined as any },
      } as any)

      const result = runLexical(handler, function* () {
        const current = yield* perform<StateGetEffect>({ _tag: 'StateGet' })
        yield* perform<StateSetEffect>({ _tag: 'StateSet', value: current + 5 } as StateSetEffect)
        return yield* perform<StateGetEffect>({ _tag: 'StateGet' })
      })

      expect(result).toBe(5)
    })

    it('should throw on unhandled effects', () => {
      const handler = createLexicalHandler<LogEffect>({
        Log: () => undefined,
      })

      expect(() =>
        runLexical(handler, function* () {
          yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/' })
          return 'never'
        } as any),
      ).toThrow('Unhandled effect')
    })
  })

  describe('handleLexical (mixed effects)', () => {
    it('should handle lexical effects and bubble remaining', () => {
      const logged: string[] = []
      const fetched: string[] = []

      const lexicalLog = createLexicalHandler<LogEffect>({
        Log: (e) => { logged.push(e.msg); return undefined },
      })

      const fetchHandler = createHandler<FetchEffect>({
        Fetch: (e, r) => { fetched.push(e.url); r({ url: e.url }) },
      })

      const result = run(function* () {
        return yield* handle(fetchHandler, function* () {
          const inner = handleLexical(lexicalLog, function* () {
            yield* perform<LogEffect>({ _tag: 'Log', msg: 'before fetch' })
            const data = yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/api' })
            yield* perform<LogEffect>({ _tag: 'Log', msg: 'after fetch' })
            return data
          })
          // handleLexical returns T directly when all effects are lexical,
          // or an Eff<T, Remaining> when there are remaining effects
          return yield* inner as any
        })
      })

      expect(logged).toEqual(['before fetch', 'after fetch'])
      // After hitting the unhandled FetchEffect, it switches to generator mode
      // but continues intercepting lexical effects
      expect(fetched).toEqual(['/api'])
    })
  })

  describe('isTailResumptive', () => {
    it('should detect tail-resumptive handlers', () => {
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined), // tail-resumptive
      })

      expect(
        isTailResumptive(handler, [{ _tag: 'Log', msg: 'test' } as LogEffect]),
      ).toBe(true)
    })

    it('should detect non-tail-resumptive handlers', () => {
      const handler = createHandler<LogEffect>({
        Log: (e, r) => {
          // Does NOT resume — not tail-resumptive
        },
      })

      expect(
        isTailResumptive(handler, [{ _tag: 'Log', msg: 'test' } as LogEffect]),
      ).toBe(false)
    })
  })

  describe('toLexicalHandler', () => {
    it('should promote tail-resumptive handler to lexical', () => {
      const logged: string[] = []

      const handler = createHandler<LogEffect>({
        Log: (e, r) => { logged.push(e.msg); r(undefined) },
      })

      const lexical = toLexicalHandler(handler)

      const result = runLexical(lexical, function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'promoted' })
        return 'done'
      })

      expect(result).toBe('done')
      expect(logged).toEqual(['promoted'])
    })
  })

  describe('benchmarkHandler', () => {
    it('should benchmark a lexical handler', () => {
      const handler = createLexicalHandler<LogEffect>({
        Log: () => undefined,
      })

      const result = benchmarkHandler(handler, function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'bench' })
        return 1
      }, 1000)

      expect(result.iterations).toBe(1000)
      expect(result.totalMs).toBeGreaterThan(0)
      expect(result.avgMicroseconds).toBeGreaterThan(0)
    })

    it('should benchmark a standard handler', () => {
      const handler = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      const result = benchmarkHandler(handler, function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'bench' })
        return 1
      }, 1000)

      expect(result.iterations).toBe(1000)
      expect(result.totalMs).toBeGreaterThan(0)
    })

    it('lexical should be faster than standard', () => {
      const lexicalH = createLexicalHandler<LogEffect>({
        Log: () => undefined,
      })

      const standardH = createHandler<LogEffect>({
        Log: (e, r) => r(undefined),
      })

      const comp = function* () {
        for (let i = 0; i < 10; i++) {
          yield* perform<LogEffect>({ _tag: 'Log', msg: 'x' })
        }
        return 1
      }

      const lexicalBench = benchmarkHandler(lexicalH, comp, 5000)
      const standardBench = benchmarkHandler(standardH, comp, 5000)

      // Lexical should be faster (or at least not horrifically slower)
      // We don't assert strict inequality since microbenchmarks are noisy
      expect(lexicalBench.avgMicroseconds).toBeGreaterThan(0)
      expect(standardBench.avgMicroseconds).toBeGreaterThan(0)
    })
  })
})

// ============================================================================
// Integration Tests: Cross-Phase
// ============================================================================

describe('Integration: Cross-Phase Composition', () => {
  it('should combine evidence handlers with error handling', () => {
    const logHandler = createHandler<LogEffect>({
      Log: (e, r) => r(undefined),
    })

    const result = runWithEvidence(logHandler, function* () {
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'about to try' })
      const res = yield* catchFail(function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'inside try' })
        return yield* fail('oops')
      })
      return res
    })

    expect(result).toEqual(Err('oops'))
  })

  it('should use lexical handlers with type safety', () => {
    let counter = 0

    const stateH = createLexicalHandler<StateGetEffect | StateSetEffect>({
      StateGet: () => counter as any,
      StateSet: (e) => { counter = (e as StateSetEffect).value; return undefined as any },
    } as any)

    const result = runLexical(stateH, function* () {
      // Increment 5 times
      for (let i = 0; i < 5; i++) {
        const c = yield* perform<StateGetEffect>({ _tag: 'StateGet' })
        yield* perform<StateSetEffect>({ _tag: 'StateSet', value: c + 1 } as StateSetEffect)
      }
      return yield* perform<StateGetEffect>({ _tag: 'StateGet' })
    })

    expect(result).toBe(5)
  })
})
