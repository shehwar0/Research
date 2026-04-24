// ============================================================================
// fx-ts — Multi-Shot Continuations
// ============================================================================
// Implements multi-shot (copyable) continuations via replay-based cloning.
//
// Theoretical basis:
//   - Cong & Asai (APLAS 2023): "One-shot control operators and
//     coroutines" — formal proof: generators < multi-shot effects
//   - Leijen (POPL 2017): Multi-resumption in algebraic effects
//
// Key insight: JavaScript generators cannot be cloned natively.
// We implement multi-shot via replay-based cloning:
//   1. Record every value sent to gen.next() during execution
//   2. To "clone" (fork), create a fresh generator and replay the
//      recorded input sequence up to the current point
//   3. This gives us correct multi-shot semantics, trading O(n)
//      replay cost for full generality
//
// Use cases:
//   - Backtracking search (amb/choose)
//   - Probabilistic programming (sample/observe)
//   - Non-deterministic testing
//   - Angelic/demonic non-determinism
// ============================================================================

import type {
  Eff,
  Effect,
  EffectSignal,
  EffectReturn,
  Handler,
} from './types.js'
import { perform, createHandler } from './core.js'

// ============================================================================
// Continuation Snapshot
// ============================================================================

/**
 * A recorded input log for replay-based continuation cloning.
 * Each entry is a value that was sent to gen.next() at that step.
 */
export type InputLog = readonly any[]

/**
 * A captured, cloneable continuation.
 *
 * Unlike one-shot continuations (which are consumed on resume),
 * a multi-shot continuation can be resumed multiple times by
 * replaying the input history on a fresh generator instance.
 */
export interface MultiShotContinuation<T> {
  /** Resume the continuation with a value, creating a new branch */
  resume(value: any): MultiShotResult<T>
  /** Clone this continuation (cheap — shares the input log) */
  clone(): MultiShotContinuation<T>
  /** The number of steps recorded so far */
  readonly depth: number
}

/**
 * Result of resuming a multi-shot continuation.
 */
export type MultiShotResult<T> =
  | { readonly done: true; readonly value: T }
  | { readonly done: false; readonly effect: EffectSignal; readonly continuation: MultiShotContinuation<T> }

// ============================================================================
// Multi-Shot Engine
// ============================================================================

/**
 * Create a multi-shot continuation from a generator function.
 *
 * The returned continuation can be resumed multiple times — each
 * resume creates a fresh branch by replaying the input history.
 *
 * @example
 * ```typescript
 * function* choices(): Eff<number, ChooseEffect> {
 *   const x = yield* choose([1, 2, 3])
 *   const y = yield* choose([10, 20])
 *   return x + y
 * }
 *
 * const cont = captureMultiShot(choices)
 * // cont can be resumed multiple times for different paths
 * ```
 */
export function captureMultiShot<T>(
  computation: () => Eff<T, any>,
  inputLog: InputLog = [],
): MultiShotContinuation<T> {
  return new ReplayContinuation(computation, [...inputLog])
}

class ReplayContinuation<T> implements MultiShotContinuation<T> {
  constructor(
    private readonly _factory: () => Eff<T, any>,
    private readonly _inputLog: any[],
  ) {}

  get depth(): number {
    return this._inputLog.length
  }

  clone(): MultiShotContinuation<T> {
    return new ReplayContinuation(this._factory, [...this._inputLog])
  }

  resume(value: any): MultiShotResult<T> {
    // Create a fresh generator and replay all recorded inputs + the new value
    const gen = this._factory()
    const newLog = [...this._inputLog, value]

    // Replay: send each recorded input to the fresh generator
    let step: IteratorResult<any, T>

    // First call is always gen.next(undefined)
    step = gen.next(undefined)

    // Replay recorded inputs (skip the first undefined)
    for (let i = 0; i < newLog.length && !step.done; i++) {
      step = gen.next(newLog[i])
    }

    if (step.done) {
      return { done: true, value: step.value }
    }

    // Generator yielded an effect at the new point
    return {
      done: false,
      effect: step.value as EffectSignal,
      continuation: new ReplayContinuation(this._factory, newLog),
    }
  }
}

// ============================================================================
// Multi-Shot Handler
// ============================================================================

/**
 * Run a computation with a multi-shot handler.
 *
 * The handler receives a cloneable continuation that can be resumed
 * multiple times. Each resume replays the computation from the start,
 * so handlers should be pure or idempotent for correct semantics.
 *
 * @returns Array of all results from all branches
 */
export function handleMultiShot<T, E extends EffectSignal>(
  handler: MultiShotHandler<E>,
  computation: () => Eff<T, E>,
): T[] {
  const results: T[] = []

  function explore(cont: MultiShotContinuation<T>, inputLog: any[]): void {
    // Create a fresh generator and replay
    const gen = computation()

    // Drive initial + replay
    let step = gen.next(undefined)
    for (let i = 0; i < inputLog.length && !step.done; i++) {
      step = gen.next(inputLog[i])
    }

    if (step.done) {
      results.push(step.value)
      return
    }

    // Hit an effect — invoke the multi-shot handler
    const effect = step.value as E

    if (handler.handles(effect)) {
      handler.handle(effect, (values: any[]) => {
        // Resume with each value — creating multiple branches
        for (const value of values) {
          explore(cont, [...inputLog, value])
        }
      })
    } else {
      throw new Error(
        `fx: Unhandled effect "${(effect as EffectSignal)._tag}" in multi-shot handler.`,
      )
    }
  }

  explore(captureMultiShot(computation), [])
  return results
}

/**
 * A multi-shot handler that can provide multiple resume values.
 */
export interface MultiShotHandler<E extends EffectSignal> {
  handles(effect: EffectSignal): effect is E
  handle(effect: E, resumeAll: (values: any[]) => void): void
  readonly tags: ReadonlySet<string>
}

/**
 * Create a multi-shot handler from a definition.
 *
 * Unlike single-shot handlers where resume takes one value,
 * multi-shot handlers call `resumeAll` with an array of values—
 * the computation is forked for each one.
 */
export function createMultiShotHandler<E extends EffectSignal>(
  def: {
    readonly [K in E['_tag']]?: (
      effect: Extract<E, { _tag: K }>,
      resumeAll: (values: any[]) => void,
    ) => void
  },
): MultiShotHandler<E> {
  const tags = new Set(Object.keys(def))

  return {
    tags,
    handles(effect: EffectSignal): effect is E {
      return tags.has(effect._tag)
    },
    handle(effect: E, resumeAll: (values: any[]) => void) {
      const fn = (def as any)[effect._tag]
      if (fn) fn(effect, resumeAll)
    },
  }
}

// ============================================================================
// Built-in Multi-Shot Effects: Choose (Non-Determinism)
// ============================================================================

/**
 * Non-deterministic choice effect.
 * The handler decides which values to explore.
 */
export interface ChooseEffect<T = unknown>
  extends Effect<'Choose', { options: T[] }, T> {
  readonly options: T[]
}

/**
 * Perform a non-deterministic choice.
 *
 * @example
 * ```typescript
 * function* pythagorean(n: number): Eff<[number, number, number], ChooseEffect<number>> {
 *   const a = yield* choose(range(1, n))
 *   const b = yield* choose(range(a, n))
 *   const c = yield* choose(range(b, n))
 *   if (a * a + b * b === c * c) return [a, b, c]
 *   return yield* fail('not a triple')
 * }
 * ```
 */
export function* choose<T>(options: T[]): Eff<T, ChooseEffect<T>> {
  return yield* perform<ChooseEffect<T>>({
    _tag: 'Choose',
    options,
  } as ChooseEffect<T>)
}

/**
 * Handler that explores ALL branches (enumerate all solutions).
 */
export function allChoicesHandler<T>(): MultiShotHandler<ChooseEffect<T>> {
  return createMultiShotHandler<ChooseEffect<T>>({
    Choose: (effect: ChooseEffect<T>, resumeAll: (values: any[]) => void) => {
      resumeAll(effect.options)
    },
  } as any)
}

/**
 * Collect all results from a non-deterministic computation.
 *
 * @example
 * ```typescript
 * const results = collectAll(function* () {
 *   const x = yield* choose([1, 2, 3])
 *   const y = yield* choose([10, 20])
 *   return x + y
 * })
 * // results === [11, 21, 12, 22, 13, 23]
 * ```
 */
export function collectAll<T>(
  computation: () => Eff<T, ChooseEffect<any>>,
): T[] {
  return handleMultiShot(
    allChoicesHandler(),
    computation,
  )
}

// ============================================================================
// Built-in Multi-Shot Effects: Amb (Ambiguity / Backtracking)
// ============================================================================

/**
 * Ambiguity effect — choose or fail.
 */
export interface AmbEffect extends Effect<'Amb', {}, boolean> {}

/**
 * Flip a coin — non-deterministic boolean.
 */
export function* amb(): Eff<boolean, AmbEffect> {
  return yield* perform<AmbEffect>({ _tag: 'Amb' } as AmbEffect)
}

/**
 * Handler that explores both branches of `amb()`.
 */
export function ambHandler(): MultiShotHandler<AmbEffect> {
  return createMultiShotHandler<AmbEffect>({
    Amb: (_effect: AmbEffect, resumeAll: (values: any[]) => void) => {
      resumeAll([true, false])
    },
  } as any)
}
