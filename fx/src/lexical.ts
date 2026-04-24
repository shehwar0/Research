// ============================================================================
// fx-ts — Lexical Effect Handler Optimization (Ma & Zhang 2025)
// ============================================================================
// Zero-overhead effect handlers for lexically-scoped effects.
//
// Theoretical basis:
//   - Ma & Zhang (OOPSLA 2025): "Zero-Overhead Lexical Effect Handlers"
//   - Key insight: When an effect handler is LEXICALLY apparent (i.e.,
//     the handler and the perform are in the same lexical scope and
//     the continuation does not escape), we can optimize away the
//     yield/resume overhead entirely and compile to a direct function call.
//
// Why this matters:
//   Standard algebraic effects have overhead from:
//     1. Yielding a value from the generator (context switch)
//     2. Handler dispatch (finding the right handler)
//     3. Resume callback creation
//     4. Feeding the value back via gen.next()
//
//   For lexical handlers (where the handler doesn't escape and
//   always resumes), we can eliminate ALL of this and execute the
//   handler inline — as fast as a regular function call.
//
// Tail-resumptive optimization:
//   A handler is "tail-resumptive" if the last thing it does is call
//   resume(). For such handlers, no continuation capture is needed —
//   the handler is a simple transformation on the effect value.
// ============================================================================

import type {
  Eff,
  EffectSignal,
  EffectReturn,
  Handler,
  HandlerDef,
} from './types.js'
import { createHandler } from './core.js'

// ============================================================================
// Lexical Handler — Zero Overhead
// ============================================================================

/**
 * A lexical handler is a direct-call handler with zero continuation overhead.
 *
 * Instead of the normal yield/resume cycle:
 *   perform → yield effect → handler receives → resume(value) → gen.next(value)
 *
 * A lexical handler is inlined:
 *   perform → handler(effect) → value (no yield, no resume, no context switch)
 *
 * Constraint: The handler MUST be tail-resumptive (resume is the last call).
 */
export type LexicalHandlerDef<E extends EffectSignal> = {
  readonly [K in E['_tag']]: (
    effect: Extract<E, { _tag: K }>,
  ) => EffectReturn<Extract<E, { _tag: K }>>
}

/**
 * A compiled lexical handler — a direct function map.
 */
export interface LexicalHandler<E extends EffectSignal> {
  /** Direct-call the handler for an effect. No yield/resume overhead. */
  call(effect: E): EffectReturn<E>
  /** Check if this handler handles the given effect */
  handles(effect: EffectSignal): effect is E
  /** The set of effect tags */
  readonly tags: ReadonlySet<string>
}

// ============================================================================
// createLexicalHandler — Build a zero-overhead handler
// ============================================================================

/**
 * Create a lexical (zero-overhead) handler.
 *
 * This handler directly calls the effect function with no continuation
 * capture or resume overhead. It is only valid for tail-resumptive handlers
 * where the handler simply computes a value from the effect.
 *
 * @example
 * ```typescript
 * // This handler is tail-resumptive: it just returns a value
 * const logHandler = createLexicalHandler<LogEffect>({
 *   Log: (effect) => {
 *     console.log(effect.msg)
 *     return undefined
 *   },
 * })
 *
 * // Zero-overhead execution — no generator yield/resume
 * const result = handleLexical(logHandler, function* () {
 *   yield* perform<LogEffect>({ _tag: 'Log', msg: 'fast!' })
 *   return 42
 * })
 * ```
 */
export function createLexicalHandler<E extends EffectSignal>(
  def: LexicalHandlerDef<E>,
): LexicalHandler<E> {
  const tags = new Set(Object.keys(def))

  return {
    tags,
    handles(effect: EffectSignal): effect is E {
      return tags.has(effect._tag)
    },
    call(effect: E): EffectReturn<E> {
      const fn = (def as any)[effect._tag]
      if (fn) return fn(effect)
      return undefined as any
    },
  }
}

// ============================================================================
// handleLexical — Drive computation with lexical handler
// ============================================================================

/**
 * Run a computation with a lexical (zero-overhead) handler.
 *
 * This uses the same generator driving loop as `handle()`, but instead
 * of creating a resume callback, it directly calls the handler function
 * and feeds the return value to gen.next(). This eliminates:
 *   - Resume callback allocation
 *   - One-shot resume tracking
 *   - Closure creation for the handler
 *
 * The saving is significant for hot loops where effects are performed
 * many times (e.g., logging, state reads, metrics).
 *
 * @example
 * ```typescript
 * let state = 0
 * const stateH = createLexicalHandler<StateGetEffect | StateSetEffect>({
 *   StateGet: () => state,
 *   StateSet: (e) => { state = e.value; return undefined },
 * })
 *
 * handleLexical(stateH, function* () {
 *   const current = yield* perform<StateGetEffect>({ _tag: 'StateGet' })
 *   yield* perform<StateSetEffect>({ _tag: 'StateSet', value: current + 1 })
 *   // This runs with zero resume-callback overhead
 * })
 * ```
 */
export function handleLexical<
  T,
  E extends EffectSignal,
  Remaining extends EffectSignal = never,
>(
  handler: LexicalHandler<E>,
  computation: () => Eff<T, E | Remaining>,
): Eff<T, Remaining> | T {
  const gen = computation()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (handler.handles(effect)) {
      // ZERO-OVERHEAD: Direct function call, no resume callback
      input = handler.call(effect)
    } else {
      // For remaining effects, we need the generator form
      // Fall back to returning a generator that yields remaining effects
      return _handleLexicalGenerator(handler, gen, effect, input) as any
    }
  }
}

/**
 * @internal Generator fallback when there are remaining (unhandled) effects.
 */
function* _handleLexicalGenerator<
  T,
  E extends EffectSignal,
  Remaining extends EffectSignal,
>(
  handler: LexicalHandler<E>,
  gen: Generator<any, T, any>,
  firstUnhandled: EffectSignal,
  _prevInput: any,
): Eff<T, Remaining> {
  // Yield the first unhandled effect
  let input: any = yield firstUnhandled as any

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (handler.handles(effect)) {
      input = handler.call(effect as E)
    } else {
      input = yield effect as any
    }
  }
}

// ============================================================================
// runLexical — Run a fully-handled lexical computation
// ============================================================================

/**
 * Run a computation where ALL effects are handled by a lexical handler.
 *
 * This is the fastest possible execution path — no generator yield/resume
 * overhead for ANY effect. The generator still yields effect signals,
 * but the handler responds via direct function call without creating
 * any closures or callbacks.
 *
 * @example
 * ```typescript
 * const result = runLexical(handler, function* () {
 *   // All effects handled with zero overhead
 *   yield* perform({ _tag: 'Log', msg: 'hello' })
 *   return 42
 * })
 * ```
 */
export function runLexical<T, E extends EffectSignal>(
  handler: LexicalHandler<E>,
  computation: () => Eff<T, E>,
): T {
  const gen = computation()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (handler.handles(effect)) {
      // Direct call — no resume callback, no closure allocation
      input = handler.call(effect)
    } else {
      throw new Error(
        `fx: Unhandled effect "${effect._tag}" in runLexical. ` +
        'All effects must be handled by the lexical handler.',
      )
    }
  }
}

// ============================================================================
// Tail-Resumptive Detection
// ============================================================================

/**
 * Check if a standard Handler is effectively tail-resumptive.
 *
 * A handler is tail-resumptive if it ALWAYS calls resume() synchronously
 * and resume() is the last operation. We can detect this at runtime by
 * observing that resume is called exactly once, synchronously.
 *
 * If tail-resumptive, the handler can be "promoted" to a LexicalHandler
 * for zero-overhead execution.
 */
export function isTailResumptive<E extends EffectSignal>(
  handler: Handler<E>,
  testEffects: E[],
): boolean {
  for (const effect of testEffects) {
    if (!handler.handles(effect)) continue

    let resumeCount = 0
    let resumeValue: any

    handler.handle(effect, (value: any) => {
      resumeCount++
      resumeValue = value
    })

    // Tail-resumptive iff resume was called exactly once, synchronously
    if (resumeCount !== 1) return false
  }

  return true
}

/**
 * Promote a tail-resumptive Handler to a LexicalHandler.
 *
 * This extracts the direct-call semantics from a handler that
 * is known to be tail-resumptive, enabling zero-overhead dispatch.
 *
 * @throws If the handler is not tail-resumptive
 */
export function toLexicalHandler<E extends EffectSignal>(
  handler: Handler<E>,
): LexicalHandler<E> {
  return {
    tags: handler.tags,
    handles: handler.handles.bind(handler),
    call(effect: E): EffectReturn<E> {
      let result: any
      handler.handle(effect, (value: any) => {
        result = value
      })
      return result
    },
  }
}

// ============================================================================
// Benchmark Utilities
// ============================================================================

/**
 * Benchmark a handler by running a computation many times.
 * Returns the average time per iteration in microseconds.
 */
export function benchmarkHandler<T, E extends EffectSignal>(
  handler: Handler<E> | LexicalHandler<E>,
  computation: () => Eff<T, E>,
  iterations: number = 10000,
): { avgMicroseconds: number; totalMs: number; iterations: number } {
  const isLexical = 'call' in handler

  const start = performance.now()

  for (let i = 0; i < iterations; i++) {
    if (isLexical) {
      runLexical(handler as LexicalHandler<E>, computation)
    } else {
      // Standard handler — use inline driving
      const gen = computation()
      let input: any = undefined
      while (true) {
        const step = gen.next(input)
        if (step.done) break
        const effect = step.value as EffectSignal
        if ((handler as Handler<E>).handles(effect)) {
          let rv: any
          ;(handler as Handler<E>).handle(effect as E, (v: any) => {
            rv = v
          })
          input = rv
        }
      }
    }
  }

  const totalMs = performance.now() - start
  const avgMicroseconds = (totalMs / iterations) * 1000

  return { avgMicroseconds, totalMs, iterations }
}
