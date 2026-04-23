// ============================================================================
// fx-ts — Comprehensive Test Suite
// ============================================================================

import { describe, it, expect, vi } from 'vitest'
import {
  // Core
  perform,
  createHandler,
  handle,
  handleAsync,
  run,
  compose,
  composeAll,
  // Types
  type Eff,
  type Effect,
  type EffectSignal,
  type Handler,
  type Pure,
  Ok, Err,
  // Errors
  fail,
  catchFail,
  recover,
  recoverWith,
  mapError,
  retry,
  type FailEffect,
  // Concurrency
  createScope,
  CancellationError,
  // Interop
  fromPromise,
  toPromise,
  type AsyncEffect,
  // AI
  generate,
  useTool,
  remember,
  recall,
  observe,
  mockGenerateHandler,
  mockToolHandler,
  inMemoryHandler,
  consoleObserveHandler,
  Model,
  type GenerateEffect,
  type ToolEffect,
  type RememberEffect,
  type RecallEffect,
  type ObserveEffect,
} from '../src/index.js'

// ============================================================================
// Test Effect Definitions
// ============================================================================

interface FetchEffect extends Effect<'Fetch', { url: string }, any> {
  readonly url: string
}

interface LogEffect extends Effect<'Log', { msg: string }, void> {
  readonly msg: string
}

interface StateGetEffect<T = number>
  extends Effect<'StateGet', {}, T> {}

interface StateSetEffect<T = number>
  extends Effect<'StateSet', { value: T }, void> {
  readonly value: T
}

interface RandomEffect
  extends Effect<'Random', {}, number> {}

// ============================================================================
// 1. Core Primitives Tests
// ============================================================================

describe('Core: perform', () => {
  it('should yield effect signals that can be received by handlers', () => {
    function* myEffect(): Eff<string, LogEffect> {
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'hello' })
      return 'done'
    }

    const gen = myEffect()
    const step = gen.next()

    expect(step.done).toBe(false)
    expect(step.value).toEqual({ _tag: 'Log', msg: 'hello' })
  })

  it('should resume with the value provided by gen.next()', () => {
    function* myEffect(): Eff<any, FetchEffect> {
      const result = yield* perform<FetchEffect>({
        _tag: 'Fetch',
        url: '/api/test',
      })
      return result
    }

    const gen = myEffect()
    gen.next() // yields the effect
    const step = gen.next({ id: 1, name: 'Test' }) // resume with value

    expect(step.done).toBe(true)
    expect(step.value).toEqual({ id: 1, name: 'Test' })
  })

  it('should support multiple sequential performs', () => {
    function* multi(): Eff<string, LogEffect> {
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'first' })
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'second' })
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'third' })
      return 'done'
    }

    const gen = multi()
    const msgs: string[] = []

    let step = gen.next()
    while (!step.done) {
      msgs.push((step.value as LogEffect).msg)
      step = gen.next()
    }

    expect(msgs).toEqual(['first', 'second', 'third'])
    expect(step.value).toBe('done')
  })
})

describe('Core: createHandler', () => {
  it('should create a handler that recognizes its effect tags', () => {
    const h = createHandler<LogEffect>({
      Log: (effect, resume) => resume(undefined),
    })

    expect(h.handles({ _tag: 'Log', msg: 'test' } as LogEffect)).toBe(true)
    expect(h.handles({ _tag: 'Fetch', url: '/api' } as any)).toBe(false)
    expect(h.tags.has('Log')).toBe(true)
  })
})

describe('Core: handle (synchronous)', () => {
  it('should handle effects and resume the computation', () => {
    const logged: string[] = []

    const logHandler = createHandler<LogEffect>({
      Log: (effect, resume) => {
        logged.push(effect.msg)
        resume(undefined)
      },
    })

    function* myComputation(): Eff<string, LogEffect> {
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'hello' })
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'world' })
      return 'done'
    }

    const result = run(() => handle(logHandler, myComputation))

    expect(result).toBe('done')
    expect(logged).toEqual(['hello', 'world'])
  })

  it('should intercept effects and provide return values', () => {
    const fetchHandler = createHandler<FetchEffect>({
      Fetch: (effect, resume) => {
        resume({ id: 1, url: effect.url })
      },
    })

    function* fetchData(): Eff<any, FetchEffect> {
      const data = yield* perform<FetchEffect>({
        _tag: 'Fetch',
        url: '/api/users',
      })
      return data
    }

    const result = run(() => handle(fetchHandler, fetchData))
    expect(result).toEqual({ id: 1, url: '/api/users' })
  })

  it('should support stateful handlers', () => {
    let counter = 0

    const stateHandler = createHandler<StateGetEffect | StateSetEffect>({
      StateGet: (_effect, resume) => {
        resume(counter as any)
      },
      StateSet: (effect, resume) => {
        counter = (effect as StateSetEffect).value
        resume(undefined as any)
      },
    } as any)

    function* increment(): Eff<number, StateGetEffect | StateSetEffect> {
      const current = yield* perform<StateGetEffect>({ _tag: 'StateGet' })
      yield* perform<StateSetEffect>({ _tag: 'StateSet', value: current + 1 } as StateSetEffect)
      return yield* perform<StateGetEffect>({ _tag: 'StateGet' })
    }

    counter = 0
    const result = run(() => handle(stateHandler, increment))
    expect(result).toBe(1)
    expect(counter).toBe(1)
  })
})

describe('Core: run', () => {
  it('should execute a pure computation', () => {
    const result = run(function* () {
      return 42
    })
    expect(result).toBe(42)
  })

  it('should throw on unhandled effects', () => {
    expect(() =>
      run(function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'oops' })
        return 'never'
      } as any)
    ).toThrow('Unhandled effect')
  })
})

// ============================================================================
// 2. Handler Composition Tests
// ============================================================================

describe('Handler Composition', () => {
  it('should compose two handlers with compose()', () => {
    const logged: string[] = []
    const fetched: string[] = []

    const logHandler = createHandler<LogEffect>({
      Log: (effect, resume) => {
        logged.push(effect.msg)
        resume(undefined)
      },
    })

    const fetchHandler = createHandler<FetchEffect>({
      Fetch: (effect, resume) => {
        fetched.push(effect.url)
        resume({ data: 'mock' })
      },
    })

    const combined = compose(logHandler, fetchHandler)

    function* bothEffects(): Eff<any, LogEffect | FetchEffect> {
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'starting' })
      const data = yield* perform<FetchEffect>({
        _tag: 'Fetch',
        url: '/api/test',
      })
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'done' })
      return data
    }

    const result = run(() => handle(combined, bothEffects))
    expect(result).toEqual({ data: 'mock' })
    expect(logged).toEqual(['starting', 'done'])
    expect(fetched).toEqual(['/api/test'])
  })

  it('should compose multiple handlers with composeAll()', () => {
    const results: string[] = []

    const h1 = createHandler<LogEffect>({
      Log: (e, r) => { results.push('log:' + e.msg); r(undefined) },
    })

    const h2 = createHandler<FetchEffect>({
      Fetch: (e, r) => { results.push('fetch:' + e.url); r('data') },
    })

    const h3 = createHandler<RandomEffect>({
      Random: (_e, r) => { results.push('random'); r(42) },
    })

    const combined = composeAll(h1, h2, h3)

    function* allEffects(): Eff<number, LogEffect | FetchEffect | RandomEffect> {
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'hi' })
      yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/test' })
      return yield* perform<RandomEffect>({ _tag: 'Random' })
    }

    const result = run(() => handle(combined, allEffects))
    expect(result).toBe(42)
    expect(results).toEqual(['log:hi', 'fetch:/test', 'random'])
  })

  it('should support nested handlers (inner before outer)', () => {
    const innerLog: string[] = []
    const outerLog: string[] = []

    const innerHandler = createHandler<LogEffect>({
      Log: (effect, resume) => {
        innerLog.push(effect.msg)
        resume(undefined)
      },
    })

    const outerHandler = createHandler<FetchEffect>({
      Fetch: (effect, resume) => {
        outerLog.push(effect.url)
        resume(`data from ${effect.url}`)
      },
    })

    function* innerComp(): Eff<string, LogEffect | FetchEffect> {
      yield* perform<LogEffect>({ _tag: 'Log', msg: 'inner' })
      return yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/api' })
    }

    // Nest: inner handler catches LogEffect, FetchEffect bubbles to outer
    const result = run(() =>
      handle(outerHandler, function* () {
        return yield* handle(innerHandler, innerComp)
      })
    )

    expect(result).toBe('data from /api')
    expect(innerLog).toEqual(['inner'])
    expect(outerLog).toEqual(['/api'])
  })
})

// ============================================================================
// 3. Async Handler Tests
// ============================================================================

describe('Async Handlers: handleAsync', () => {
  it('should handle async effects via handleAsync', async () => {
    const fetchHandler = createHandler<FetchEffect>({
      Fetch: (effect, resume) => {
        // Simulate async operation
        setTimeout(() => {
          resume({ url: effect.url, data: 'async data' })
        }, 10)
      },
    })

    const result = await handleAsync(fetchHandler, function* () {
      const data = yield* perform<FetchEffect>({
        _tag: 'Fetch',
        url: '/api/test',
      })
      return data
    })

    expect(result).toEqual({ url: '/api/test', data: 'async data' })
  })

  it('should handle multiple async effects sequentially', async () => {
    const order: string[] = []

    const fetchHandler = createHandler<FetchEffect>({
      Fetch: (effect, resume) => {
        order.push(`start:${effect.url}`)
        setTimeout(() => {
          order.push(`end:${effect.url}`)
          resume(`data:${effect.url}`)
        }, 5)
      },
    })

    const result = await handleAsync(fetchHandler, function* () {
      const a = yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/a' })
      const b = yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/b' })
      return [a, b]
    })

    expect(result).toEqual(['data:/a', 'data:/b'])
    expect(order).toEqual(['start:/a', 'end:/a', 'start:/b', 'end:/b'])
  })

  it('should reject on unhandled effects', async () => {
    const logHandler = createHandler<LogEffect>({
      Log: (_e, r) => r(undefined),
    })

    await expect(
      handleAsync(logHandler, function* () {
        yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/oops' })
        return 'never'
      } as any)
    ).rejects.toThrow('Unhandled effect')
  })
})

// ============================================================================
// 4. Error Handling Tests
// ============================================================================

describe('Error Handling: fail & catchFail', () => {
  interface NotFoundError {
    readonly _tag: 'NotFound'
    readonly id: number
  }

  it('should catch typed errors as Result', () => {
    function* findUser(id: number): Eff<string, FailEffect<NotFoundError>> {
      if (id === 0) {
        yield* fail<NotFoundError>({ _tag: 'NotFound', id })
      }
      return `user-${id}`
    }

    // Success case
    const success = run(function* () {
      return yield* catchFail(function* () {
        return yield* findUser(42)
      })
    })
    expect(success).toEqual(Ok('user-42'))

    // Failure case
    const failure = run(function* () {
      return yield* catchFail(function* () {
        return yield* findUser(0)
      })
    })
    expect(failure).toEqual(Err({ _tag: 'NotFound', id: 0 }))
  })

  it('should recover from errors with a fallback', () => {
    function* riskyOp(): Eff<number, FailEffect<string>> {
      return yield* fail('boom')
    }

    const result = run(function* () {
      return yield* recover(riskyOp, (error) => {
        expect(error).toBe('boom')
        return -1
      })
    })

    expect(result).toBe(-1)
  })

  it('should map errors to different types', () => {
    interface AppError { code: number; msg: string }

    function* lowLevel(): Eff<number, FailEffect<string>> {
      return yield* fail('disk error')
    }

    const result = run(function* () {
      return yield* catchFail(function* () {
        return yield* mapError(lowLevel, (e) => ({
          code: 500,
          msg: e,
        }))
      })
    })

    expect(result).toEqual(Err({ code: 500, msg: 'disk error' }))
  })
})

describe('Error Handling: retry', () => {
  it('should retry on failure and succeed on later attempt', () => {
    let attempts = 0

    function* flaky(): Eff<string, FailEffect<string>> {
      attempts++
      if (attempts < 3) {
        return yield* fail('not yet')
      }
      return 'success!'
    }

    attempts = 0
    const result = run(function* () {
      return yield* catchFail(function* () {
        return yield* retry(5, flaky)
      })
    })

    expect(result).toEqual(Ok('success!'))
    expect(attempts).toBe(3)
  })

  it('should exhaust retries and return error', () => {
    function* alwaysFails(): Eff<never, FailEffect<string>> {
      return yield* fail('permanent')
    }

    const result = run(function* () {
      return yield* catchFail(function* () {
        return yield* retry(3, alwaysFails)
      })
    })

    expect(result).toEqual(Err('permanent'))
  })
})

// ============================================================================
// 5. Structured Concurrency Tests
// ============================================================================

describe('Structured Concurrency: Scope', () => {
  it('should create scope with active status', () => {
    const scope = createScope()
    expect(scope.active).toBe(true)
    expect(scope.children.size).toBe(0)
  })

  it('should close scope and become inactive', () => {
    const scope = createScope()
    scope.close()
    expect(scope.active).toBe(false)
  })

  it('should not allow spawning in closed scope', () => {
    const scope = createScope()
    scope.close()
    expect(() => scope.spawn(function* () { return 1 })).toThrow(
      'Cannot spawn in a closed scope'
    )
  })

  it('should cancel children when scope closes', () => {
    const scope = createScope()
    const task = scope.spawn(function* () {
      return 'never completes'
    })

    scope.close()
    expect(task.status).toBe('cancelled')
  })

  it('should close child scopes when parent closes', () => {
    const parent = createScope()
    const child = createScope(parent)

    expect(child.active).toBe(true)
    parent.close()
    expect(child.active).toBe(false)
  })
})

// ============================================================================
// 6. Interop Tests
// ============================================================================

describe('Interop: fromPromise & toPromise', () => {
  it('should lift a promise into an effect and resolve', async () => {
    function* fetchData(): Eff<string, AsyncEffect<string>> {
      return yield* fromPromise(async () => 'hello from promise')
    }

    const result = await toPromise(fetchData)
    expect(result).toBe('hello from promise')
  })

  it('should handle promise rejection', async () => {
    function* failingFetch(): Eff<string, AsyncEffect<string>> {
      return yield* fromPromise(async () => {
        throw new Error('network error')
      })
    }

    await expect(toPromise(failingFetch)).rejects.toThrow('network error')
  })

  it('should handle chain of async effects', async () => {
    function* chain(): Eff<number, AsyncEffect<any>> {
      const a = yield* fromPromise(async () => 10)
      const b = yield* fromPromise(async () => 20)
      const c = yield* fromPromise(async () => a + b)
      return c
    }

    const result = await toPromise(chain)
    expect(result).toBe(30)
  })
})

// ============================================================================
// 7. AI Agent Effects Tests
// ============================================================================

describe('AI Agent Effects', () => {
  it('should generate text with mock handler', () => {
    const mockLLM = mockGenerateHandler((prompt) => `Response to: ${prompt}`)

    function* myAgent(): Eff<string, GenerateEffect> {
      return yield* generate('What is 2+2?', Model.Fast)
    }

    const result = run(() => handle(mockLLM, myAgent))
    expect(result).toBe('Response to: What is 2+2?')
  })

  it('should use tools with mock handler', () => {
    const mockTools = mockToolHandler((name, args) => {
      if (name === 'calculator') return { result: 42 }
      return { error: 'unknown tool' }
    })

    function* myAgent(): Eff<any, ToolEffect> {
      return yield* useTool('calculator', { operation: 'add', a: 20, b: 22 })
    }

    const result = run(() => handle(mockTools, myAgent))
    expect(result).toEqual({ result: 42 })
  })

  it('should store and recall from memory', () => {
    const memoryHandler = inMemoryHandler()

    function* myAgent(): Eff<string | undefined, RememberEffect | RecallEffect> {
      yield* remember('user', 'Alice')
      const user = yield* recall('user')
      return user as string | undefined
    }

    const result = run(() => handle(memoryHandler, myAgent))
    expect(result).toBe('Alice')
  })

  it('should compose all AI handlers for a complete agent', () => {
    const llm = mockGenerateHandler((prompt) => `Summary of: ${prompt}`)
    const tools = mockToolHandler((name) => [`result from ${name}`])
    const memory = inMemoryHandler()
    const obs = consoleObserveHandler()

    const combined = composeAll(llm, tools, memory, obs)

    function* researchAgent(
      query: string,
    ): Eff<string, GenerateEffect | ToolEffect | RememberEffect | RecallEffect | ObserveEffect> {
      yield* observe('agent:start', { query })
      const searchResults = yield* useTool('search', { query })
      yield* remember('search_results', searchResults)
      const summary = yield* generate(`Summarize: ${query}`)
      yield* observe('agent:complete', { summary })
      return summary
    }

    const result = run(() =>
      handle(combined, function* () {
        return yield* researchAgent('algebraic effects')
      })
    )

    expect(result).toBe('Summary of: Summarize: algebraic effects')
  })

  it('should swap handlers for testing without code changes', () => {
    // The SAME business logic function
    function* businessLogic(): Eff<string, GenerateEffect> {
      const greeting = yield* generate('Say hello', Model.Fast)
      return `Agent says: ${greeting}`
    }

    // Production handler
    const prodHandler = mockGenerateHandler(() => 'Hello from GPT-4!')

    // Test handler — completely different implementation
    const testHandler = mockGenerateHandler(() => 'MOCK_RESPONSE')

    // SAME code, different handlers — zero changes to business logic
    const prodResult = run(() => handle(prodHandler, businessLogic))
    const testResult = run(() => handle(testHandler, businessLogic))

    expect(prodResult).toBe('Agent says: Hello from GPT-4!')
    expect(testResult).toBe('Agent says: MOCK_RESPONSE')
  })
})

// ============================================================================
// 8. One-Shot Continuation Safety Tests
// ============================================================================

describe('One-Shot Safety', () => {
  it('should throw on double resume', () => {
    const badHandler = createHandler<LogEffect>({
      Log: (effect, resume) => {
        resume(undefined)
        // Attempting to resume again — should throw
        expect(() => resume(undefined)).toThrow('one-shot')
      },
    })

    run(() =>
      handle(badHandler, function* () {
        yield* perform<LogEffect>({ _tag: 'Log', msg: 'test' })
        return 'done'
      })
    )
  })
})

// ============================================================================
// 9. Complex Composition Tests (Real-World Scenarios)
// ============================================================================

describe('Real-World: Multi-Layer Effect Composition', () => {
  it('should compose logging, state, and fetch across layers', () => {
    const logs: string[] = []
    let state = 0

    const logH = createHandler<LogEffect>({
      Log: (e, r) => { logs.push(e.msg); r(undefined) },
    })

    const stateH = createHandler<StateGetEffect | StateSetEffect>({
      StateGet: (_e, r) => r(state as any),
      StateSet: (e, r) => { state = (e as StateSetEffect).value; r(undefined as any) },
    } as any)

    const fetchH = createHandler<FetchEffect>({
      Fetch: (e, r) => r({ url: e.url, cached: true }),
    })

    // Business logic uses all three effect types
    function* processOrder(
      orderId: number,
    ): Eff<any, LogEffect | StateGetEffect | StateSetEffect | FetchEffect> {
      yield* perform<LogEffect>({ _tag: 'Log', msg: `Processing order ${orderId}` })
      const count = yield* perform<StateGetEffect>({ _tag: 'StateGet' })
      yield* perform<StateSetEffect>({ _tag: 'StateSet', value: count + 1 } as StateSetEffect)
      const data = yield* perform<FetchEffect>({
        _tag: 'Fetch',
        url: `/api/orders/${orderId}`,
      })
      yield* perform<LogEffect>({ _tag: 'Log', msg: `Order fetched: ${data.url}` })
      return { order: data, processedCount: count + 1 }
    }

    const combined = composeAll(logH, stateH, fetchH)
    state = 0
    logs.length = 0

    const result = run(() =>
      handle(combined, function* () {
        return yield* processOrder(123)
      })
    )

    expect(result).toEqual({
      order: { url: '/api/orders/123', cached: true },
      processedCount: 1,
    })
    expect(logs).toEqual([
      'Processing order 123',
      'Order fetched: /api/orders/123',
    ])
    expect(state).toBe(1)
  })
})
