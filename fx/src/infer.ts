// ============================================================================
// fx-ts — Effect Row Type Inference Helpers
// ============================================================================
// Advanced TypeScript type-level utilities for effect row inference
// and type-safe handler construction.
//
// Theoretical basis:
//   - Leijen (POPL 2017): Row-typed algebraic effects
//   - Brachthäuser (OOPSLA 2018): Capability-passing type safety
//
// These types provide compile-time guarantees that:
//   1. All effects are handled before execution (InferEffects)
//   2. Handlers match the effects they claim to handle (HandlerFor)
//   3. Effect composition preserves type safety (MergeEffects)
//   4. Effect elimination is tracked precisely (Handled, remaining)
// ============================================================================

import type {
  Eff,
  EffectSignal,
  Effect,
  EffectReturn,
  Handler,
  HandlerDef,
  ResumeFn,
  Handled,
} from './types.js'

// ============================================================================
// Effect Row Inference
// ============================================================================

/**
 * Extract the effect row (the set of effects) from an Eff computation type.
 *
 * @example
 * ```typescript
 * type MyComp = Eff<string, FetchEffect | LogEffect>
 * type Effects = InferEffects<MyComp>
 * //=> FetchEffect | LogEffect
 * ```
 */
export type InferEffects<T> = T extends Eff<any, infer E> ? E : never

/**
 * Extract the return type from an Eff computation type.
 *
 * @example
 * ```typescript
 * type MyComp = Eff<string, FetchEffect>
 * type Return = InferReturn<MyComp>
 * //=> string
 * ```
 */
export type InferReturn<T> = T extends Eff<infer A, any> ? A : never

/**
 * Check if a computation has any unhandled effects.
 * Resolves to `true` if effects remain, `false` if the computation is pure.
 *
 * @example
 * ```typescript
 * type NeedsFetch = RequiresHandling<Eff<string, FetchEffect>>
 * //=> true
 *
 * type IsPure = RequiresHandling<Eff<string, never>>
 * //=> false
 * ```
 */
export type RequiresHandling<T> = T extends Eff<any, infer E>
  ? [E] extends [never]
    ? false
    : true
  : false

/**
 * Assert that a computation is pure (all effects handled).
 * This is a compile-time assertion — it produces `never` if
 * unhandled effects remain.
 *
 * @example
 * ```typescript
 * type Good = AssertPure<Eff<string, never>>
 * //=> Eff<string, never>
 *
 * type Bad = AssertPure<Eff<string, FetchEffect>>
 * //=> never (compile error)
 * ```
 */
export type AssertPure<T extends Eff<any, any>> =
  RequiresHandling<T> extends true ? never : T

// ============================================================================
// Handler Type Inference
// ============================================================================

/**
 * Derive the required handler definition type from an effect type.
 *
 * @example
 * ```typescript
 * type FetchHandlerDef = HandlerFor<FetchEffect>
 * //=> { Fetch: (effect: FetchEffect, resume: ResumeFn<Response>) => void }
 * ```
 */
export type HandlerFor<E extends EffectSignal> = {
  readonly [K in E['_tag']]: (
    effect: Extract<E, { _tag: K }>,
    resume: ResumeFn<EffectReturn<Extract<E, { _tag: K }>>>,
  ) => void
}

/**
 * Derive the remaining effects after handling a subset.
 *
 * @example
 * ```typescript
 * type All = FetchEffect | LogEffect | DbEffect
 * type AfterFetch = RemainingEffects<All, FetchEffect>
 * //=> LogEffect | DbEffect
 * ```
 */
export type RemainingEffects<
  Row extends EffectSignal,
  Eliminated extends EffectSignal,
> = Handled<Row, Eliminated>

// ============================================================================
// Effect Row Operations
// ============================================================================

/**
 * Merge two effect rows into one.
 *
 * @example
 * ```typescript
 * type Combined = MergeEffects<FetchEffect, LogEffect>
 * //=> FetchEffect | LogEffect
 * ```
 */
export type MergeEffects<
  E1 extends EffectSignal,
  E2 extends EffectSignal,
> = E1 | E2

/**
 * Check if an effect row contains a specific effect type.
 *
 * @example
 * ```typescript
 * type HasFetch = ContainsEffect<FetchEffect | LogEffect, FetchEffect>
 * //=> true
 *
 * type HasDb = ContainsEffect<FetchEffect | LogEffect, DbEffect>
 * //=> false
 * ```
 */
export type ContainsEffect<
  Row extends EffectSignal,
  E extends EffectSignal,
> = E extends Row ? true : false

/**
 * Extract effects matching a specific tag from a row.
 *
 * @example
 * ```typescript
 * type FetchOnly = ExtractEffect<FetchEffect | LogEffect, 'Fetch'>
 * //=> FetchEffect
 * ```
 */
export type ExtractEffect<
  Row extends EffectSignal,
  Tag extends string,
> = Extract<Row, { _tag: Tag }>

/**
 * Get all effect tags from an effect row as a union of string literals.
 *
 * @example
 * ```typescript
 * type Tags = EffectTagsOf<FetchEffect | LogEffect>
 * //=> 'Fetch' | 'Log'
 * ```
 */
export type EffectTagsOf<E extends EffectSignal> = E['_tag']

// ============================================================================
// Computation Type Combinators
// ============================================================================

/**
 * The type of a computation that produces `A` after handling effect `E`
 * from a computation that performs effects `E | R`.
 *
 * This is the type signature of a handler function applied to a computation.
 *
 * @example
 * ```typescript
 * type HandleFetch = WithHandled<string, FetchEffect, FetchEffect | LogEffect>
 * //=> Eff<string, LogEffect>
 * ```
 */
export type WithHandled<
  A,
  E extends EffectSignal,
  Row extends EffectSignal,
> = Eff<A, Handled<Row, E>>

/**
 * The type of piping a computation through multiple handlers.
 *
 * @example
 * ```typescript
 * type After = PipeHandled<string, FetchEffect | LogEffect, [FetchEffect, LogEffect]>
 * //=> Eff<string, never>  (all effects handled)
 * ```
 */
export type PipeHandled<
  A,
  Row extends EffectSignal,
  Handlers extends EffectSignal[],
> = Handlers extends [infer H extends EffectSignal, ...infer Rest extends EffectSignal[]]
  ? PipeHandled<A, Handled<Row, H>, Rest>
  : Eff<A, Row>

// ============================================================================
// Effect Function Type Helpers
// ============================================================================

/**
 * Extract the effects performed by a generator function.
 *
 * @example
 * ```typescript
 * function* myFn(): Eff<string, FetchEffect | LogEffect> { ... }
 * type Effects = EffectsOf<typeof myFn>
 * //=> FetchEffect | LogEffect
 * ```
 */
export type EffectsOf<T extends (...args: any[]) => Eff<any, any>> =
  ReturnType<T> extends Eff<any, infer E> ? E : never

/**
 * Extract the return value type of a generator function.
 */
export type ReturnOf<T extends (...args: any[]) => Eff<any, any>> =
  ReturnType<T> extends Eff<infer A, any> ? A : never

// ============================================================================
// Handler Composition Type Helpers
// ============================================================================

/**
 * Type-level check: Does a handler handle all required effects?
 *
 * @example
 * ```typescript
 * type Check = HandlerCovers<Handler<FetchEffect | LogEffect>, FetchEffect | LogEffect>
 * //=> true
 * ```
 */
export type HandlerCovers<
  H extends Handler<any>,
  Required extends EffectSignal,
> = H extends Handler<infer Handled>
  ? Required extends Handled
    ? true
    : false
  : false

/**
 * Derive the type of a composed handler from two handlers.
 */
export type ComposedHandler<
  H1 extends Handler<any>,
  H2 extends Handler<any>,
> = H1 extends Handler<infer E1>
  ? H2 extends Handler<infer E2>
    ? Handler<E1 | E2>
    : never
  : never
