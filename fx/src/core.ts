// ============================================================================
// fx-ts — Core Primitives: perform, withHandler, resume
// ============================================================================
// The heart of the algebraic effects system.
//
// Theoretical basis:
//   - Plotkin & Pretnar (2009/2013): Handling Algebraic Effects
//   - Kawahara & Kameyama (TFP 2020): One-shot effects ≡ coroutines
//   - Brachthäuser (OOPSLA 2018): Capability-passing
//
// Key insight: JavaScript generators (function*) are asymmetric coroutines.
// A suspended generator IS a one-shot delimited continuation.
// yield = perform (suspend and send effect signal)
// gen.next(value) = resume (continue from suspension point)
// ============================================================================

import type {
  Eff,
  EffectSignal,
  EffectReturn,
  Handler,
  HandlerDef,
} from './types.js'

// ============================================================================
// perform — Suspend computation and signal an effect
// ============================================================================

/**
 * Perform an algebraic effect.
 *
 * This suspends the current computation and yields the effect signal
 * to the nearest enclosing handler. The handler may resume the
 * computation by calling `resume(value)`, providing the value that
 * `perform` returns.
 *
 * @example
 * ```typescript
 * interface FetchEffect extends Effect<'Fetch', { url: string }, Response> {
 *   readonly url: string
 * }
 *
 * function* fetchUser(id: number): Eff<User, FetchEffect> {
 *   const response = yield* perform<FetchEffect>({
 *     _tag: 'Fetch',
 *     url: `/api/users/${id}`
 *   })
 *   return response.json()
 * }
 * ```
 */
export function* perform<E extends EffectSignal>(
  effect: E,
): Eff<EffectReturn<E>, E> {
  return (yield effect) as EffectReturn<E>
}

// ============================================================================
// createHandler — Build a Handler from a definition object
// ============================================================================

/**
 * Create a typed Handler from a definition mapping effect tags to callbacks.
 *
 * @example
 * ```typescript
 * const fetchHandler = createHandler<FetchEffect>({
 *   Fetch: (effect, resume) => {
 *     fetch(effect.url).then(r => resume(r))
 *   }
 * })
 * ```
 */
export function createHandler<E extends EffectSignal>(
  def: HandlerDef<E>,
): Handler<E> {
  const tags = new Set(Object.keys(def))

  return {
    tags,
    handles(effect: EffectSignal): effect is E {
      return tags.has(effect._tag)
    },
    handle(effect: E, resume) {
      const fn = (def as any)[effect._tag]
      if (fn) {
        fn(effect, resume)
      }
    },
  }
}

// ============================================================================
// withHandler — Install an effect handler around a computation
// ============================================================================

/**
 * Internal: result wrapper for the handler loop.
 */
interface HandlerResult<T> {
  done: boolean
  value: T | undefined
  error?: unknown
}

/**
 * Run a computation under an effect handler.
 *
 * When the computation performs an effect that matches this handler,
 * the handler callback is invoked with the effect and a resume function.
 * Calling `resume(value)` continues the computation from where it
 * performed the effect.
 *
 * Effects that are NOT handled by this handler "bubble up" to the
 * next enclosing handler — this is how handler composition works.
 *
 * The return type eliminates handled effects from the effect row:
 * if the computation performs `FetchEffect | LogEffect` and the handler
 * handles `FetchEffect`, the result computation performs only `LogEffect`.
 *
 * @example
 * ```typescript
 * const result = yield* withHandler(fetchHandler, function* () {
 *   const user = yield* fetchUser(42)
 *   return user.name
 * })
 * ```
 */
export function* withHandler<
  T,
  E extends EffectSignal,
  Remaining extends EffectSignal = never,
>(
  handler: Handler<E>,
  computation: () => Eff<T, E | Remaining>,
): Eff<T, Remaining> {
  const gen = computation()
  let input: any = undefined
  let isThrow = false

  while (true) {
    let step: IteratorResult<any, T>
    try {
      if (isThrow) {
        step = gen.throw(input)
        isThrow = false
      } else {
        step = gen.next(input)
      }
    } catch (error) {
      throw error
    }

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (handler.handles(effect)) {
      // This handler handles this effect.
      // Create a one-shot resume function that captures the continuation.
      let resumed = false
      const resumeValue = yield* makeResumePoint<EffectReturn<E>>()
      
      if (resumeValue.__type === 'resume_setup') {
        // First time — invoke the handler with the resume callback
        const capturedResolve = resumeValue.resolve
        handler.handle(effect as E, (value: EffectReturn<E>) => {
          if (resumed) {
            throw new Error(
              'fx: Cannot resume a one-shot continuation more than once. ' +
              'Multi-shot continuations require Phase 3 (generator cloning).'
            )
          }
          resumed = true
          capturedResolve(value)
        })
        // If handler didn't resume synchronously, we need to wait
        if (!resumed) {
          // The handler will call resume() asynchronously
          // We need to suspend the outer generator too
          continue
        }
      } else {
        // Handler resumed — feed the value back into the computation
        input = resumeValue.value
        continue
      }
    } else {
      // Effect not handled here — bubble up to outer handler
      input = yield effect as Remaining
    }
  }
}

/**
 * @internal Resume point helper — creates a suspension point for handler resume.
 */
type ResumeSetup<T> = { __type: 'resume_setup'; resolve: (value: T) => void }
type ResumeValue<T> = { __type: 'resume_value'; value: T }

function* makeResumePoint<T>(): Generator<never, ResumeSetup<T> | ResumeValue<T>, any> {
  // This is a trick — we use the calling convention to thread values
  return { __type: 'resume_setup', resolve: () => {} } as any
}

// ============================================================================
// Simplified synchronous withHandler for immediate-resume handlers
// ============================================================================

/**
 * Run a computation with a synchronous handler.
 *
 * This is the primary handler mechanism. It works by driving the
 * computation generator step-by-step. When an effect is encountered:
 *   1. If the handler handles it, the handler callback is invoked.
 *      The handler MUST call `resume(value)` synchronously.
 *   2. If the handler does not handle it, the effect bubbles up
 *      by being re-yielded to the outer generator.
 *
 * For async handlers, use `withAsyncHandler` instead.
 *
 * @example
 * ```typescript
 * // Synchronous handler — resume immediately
 * const logHandler = createHandler<LogEffect>({
 *   Log: (effect, resume) => {
 *     console.log(effect.msg)
 *     resume(undefined)
 *   }
 * })
 *
 * function* myComputation(): Eff<string, LogEffect> {
 *   yield* perform<LogEffect>({ _tag: 'Log', msg: 'hello' })
 *   return 'done'
 * }
 *
 * const result = yield* handle(logHandler, myComputation)
 * // result === 'done', and 'hello' was logged
 * ```
 */
export function* handle<
  T,
  E extends EffectSignal,
  Remaining extends EffectSignal = never,
>(
  handler: Handler<E>,
  computation: () => Eff<T, E | Remaining>,
): Eff<T, Remaining> {
  const gen = computation()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (handler.handles(effect)) {
      // Handler matches — invoke it with a synchronous resume
      let resumeValue: any = undefined
      let didResume = false

      handler.handle(effect as E, (value: EffectReturn<E>) => {
        if (didResume) {
          throw new Error(
            'fx: Cannot resume a one-shot continuation more than once.'
          )
        }
        didResume = true
        resumeValue = value
      })

      if (!didResume) {
        throw new Error(
          'fx: Synchronous handler for "' + effect._tag + '" did not call resume(). ' +
          'For async handlers, use handleAsync() instead.'
        )
      }

      input = resumeValue
    } else {
      // Bubble up unhandled effects
      input = yield effect as any
    }
  }
}

// ============================================================================
// handleAsync — Handler with async resume support
// ============================================================================

/**
 * Run a computation with an async-capable handler.
 *
 * Unlike `handle()`, this returns a Promise and supports handlers
 * that call `resume()` asynchronously (e.g., after a fetch or timeout).
 *
 * @example
 * ```typescript
 * const fetchHandler = createHandler<FetchEffect>({
 *   Fetch: (effect, resume) => {
 *     fetch(effect.url)
 *       .then(r => r.json())
 *       .then(data => resume(data))
 *   }
 * })
 *
 * const user = await handleAsync(fetchHandler, function* () {
 *   return yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/api/user/1' })
 * })
 * ```
 */
export function handleAsync<
  T,
  E extends EffectSignal,
>(
  handler: Handler<E>,
  computation: () => Eff<T, E>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const gen = computation()

    function drive(input: any): void {
      try {
        const step = gen.next(input)

        if (step.done) {
          resolve(step.value)
          return
        }

        const effect = step.value as EffectSignal

        if (handler.handles(effect)) {
          let didResume = false
          handler.handle(effect as E, (value: EffectReturn<E>) => {
            if (didResume) {
              reject(
                new Error('fx: Cannot resume a one-shot continuation more than once.')
              )
              return
            }
            didResume = true
            // Continue driving the generator with the resumed value
            drive(value)
          })

          if (!didResume) {
            // Handler will resume asynchronously — nothing to do now
          }
        } else {
          reject(
            new Error(
              `fx: Unhandled effect "${effect._tag}". ` +
              'All effects must be handled before execution.'
            )
          )
        }
      } catch (error) {
        reject(error)
      }
    }

    drive(undefined)
  })
}

// ============================================================================
// run — Execute a pure (fully-handled) computation
// ============================================================================

/**
 * Run a pure computation (all effects have been handled) and extract its value.
 *
 * This function drives a generator to completion with no effect handling.
 * If the computation yields any effect, it throws an error.
 *
 * @example
 * ```typescript
 * const value = run(function* () {
 *   return 42
 * })
 * // value === 42
 * ```
 */
export function run<T>(computation: () => Eff<T, any>): T {
  const gen = computation()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    // Pure computation should never yield effects
    const effect = step.value as EffectSignal
    throw new Error(
      `fx: Unhandled effect "${effect?._tag ?? 'unknown'}" in pure computation. ` +
      'Ensure all effects are handled before calling run().'
    )
  }
}

// ============================================================================
// runAsync — Execute a fully-handled async computation
// ============================================================================

/**
 * Run a computation that may contain async handlers.
 * Returns a Promise of the final value.
 *
 * This is the top-level entry point for async effect computations.
 *
 * @example
 * ```typescript
 * const user = await runAsync(() =>
 *   handle(fetchHandler, function* () {
 *     return yield* fetchUser(42)
 *   })
 * )
 * ```
 */
export async function runAsync<T>(computation: () => Eff<T, any>): Promise<T> {
  return run(computation)
}

// ============================================================================
// Compose handlers
// ============================================================================

/**
 * Compose two handlers into one that handles effects from both.
 *
 * @example
 * ```typescript
 * const combined = compose(fetchHandler, logHandler)
 * const result = yield* handle(combined, myComputation)
 * ```
 */
export function compose<E1 extends EffectSignal, E2 extends EffectSignal>(
  h1: Handler<E1>,
  h2: Handler<E2>,
): Handler<E1 | E2> {
  const tags = new Set([...h1.tags, ...h2.tags])

  return {
    tags,
    handles(effect: EffectSignal): effect is E1 | E2 {
      return h1.handles(effect) || h2.handles(effect)
    },
    handle(effect: E1 | E2, resume: any) {
      if (h1.handles(effect)) {
        h1.handle(effect, resume)
      } else if (h2.handles(effect)) {
        h2.handle(effect, resume)
      }
    },
  }
}

/**
 * Compose multiple handlers into a single handler.
 */
export function composeAll<E extends EffectSignal>(
  ...handlers: Handler<any>[]
): Handler<E> {
  const tags = new Set<string>()
  for (const h of handlers) {
    for (const t of h.tags) tags.add(t)
  }

  return {
    tags,
    handles(effect: EffectSignal): effect is E {
      return handlers.some((h) => h.handles(effect))
    },
    handle(effect: E, resume: any) {
      for (const h of handlers) {
        if (h.handles(effect)) {
          h.handle(effect, resume)
          return
        }
      }
    },
  }
}
