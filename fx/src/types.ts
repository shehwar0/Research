// ============================================================================
// fx-ts — Core Type System
// ============================================================================
// Typed algebraic effect rows via TypeScript's type system.
//
// Theoretical basis:
//   - Leijen (POPL 2017): Row-typed algebraic effects
//   - Brachthäuser (OOPSLA 2018): Capability-passing for effect safety
//   - Kawahara & Kameyama (TFP 2020): One-shot effects ≡ coroutines
// ============================================================================

/**
 * Base interface for all effect signals.
 * Every effect must have a unique `_tag` discriminant.
 */
export interface EffectSignal {
  readonly _tag: string
}

/**
 * A branded type for distinguishing specific effect kinds.
 * The `_Return` phantom type tracks what the handler returns to the performer.
 */
export interface Effect<Tag extends string, Payload = {}, Return = unknown>
  extends EffectSignal {
  readonly _tag: Tag
  /** @internal Phantom type — never read at runtime */
  readonly _Return?: Return
}

/**
 * Extract the return type of an effect signal.
 */
export type EffectReturn<E extends EffectSignal> = E extends Effect<
  any,
  any,
  infer R
>
  ? R
  : unknown

/**
 * An algebraic effect computation.
 *
 * `Eff<A, E>` represents a computation that:
 *   - Returns a value of type `A`
 *   - May perform effects from the effect row `E`
 *
 * When `E = never`, the computation is "pure" — all effects have been handled.
 *
 * Internally implemented as a Generator that yields effect signals and
 * receives handler responses via `gen.next(value)`.
 */
export type Eff<A, E extends EffectSignal = never> = Generator<E, A, any>

/**
 * A pure computation — all effects have been handled.
 */
export type Pure<A> = Eff<A, never>

/**
 * An effectful generator function.
 */
export type EffFn<A, E extends EffectSignal = never, Args extends any[] = []> =
  (...args: Args) => Eff<A, E>

/**
 * Type-level operation: exclude handled effects from a row.
 *
 * When a handler handles `FetchEffect`, the resulting computation's
 * effect row has `FetchEffect` removed:
 *
 * ```
 * Handled<FetchEffect | LogEffect, FetchEffect> = LogEffect
 * ```
 */
export type Handled<
  Row extends EffectSignal,
  Eliminated extends EffectSignal,
> = Exclude<Row, Eliminated>

/**
 * Extract all effect tags from an effect row.
 */
export type EffectTags<E extends EffectSignal> = E extends { _tag: infer T }
  ? T
  : never

// ============================================================================
// Handler Types
// ============================================================================

/**
 * A resume function passed to effect handlers.
 * Calling `resume(value)` continues the suspended computation
 * from the `perform` site with the given value.
 */
export type ResumeFn<T> = (value: T) => void

/**
 * The handler callback for a single effect operation.
 *
 * Receives the effect signal and a resume function.
 * The handler can:
 *   1. Call `resume(value)` to continue the computation (one-shot)
 *   2. Return a value without resuming (abort/short-circuit)
 *   3. Perform async work before resuming
 */
export type EffectHandler<E extends EffectSignal> = (
  effect: E,
  resume: ResumeFn<EffectReturn<E>>,
) => void

/**
 * A handler definition mapping effect tags to handler callbacks.
 */
export type HandlerDef<E extends EffectSignal> = {
  readonly [K in E['_tag']]?: (
    effect: Extract<E, { _tag: K }>,
    resume: ResumeFn<EffectReturn<Extract<E, { _tag: K }>>>,
  ) => void
}

/**
 * A complete Handler object that can intercept and handle effects.
 */
export interface Handler<E extends EffectSignal> {
  /** Check if this handler can handle the given effect */
  handles(effect: EffectSignal): effect is E
  /** Handle the effect, optionally resuming the continuation */
  handle: EffectHandler<E>
  /** The set of effect tags this handler manages */
  readonly tags: ReadonlySet<string>
}

// ============================================================================
// Scope & Task Types
// ============================================================================

/** Unique ID for tasks */
export type TaskId = number & { readonly __brand: 'TaskId' }

/** Status of a running task */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * A handle to a concurrently running computation.
 * Provides operations to observe or cancel the computation.
 */
export interface Task<T> {
  readonly id: TaskId
  /** Wait for the task to complete and return its result */
  readonly promise: Promise<T>
  /** Cancel this task and all its children */
  cancel(): void
  /** Current status */
  readonly status: TaskStatus
}

/**
 * A Scope manages the lifetime of child tasks.
 * When a scope is closed, all its children are automatically cancelled.
 * This is the core primitive for structured concurrency.
 *
 * Inspired by: OCaml Eio Switch, Kotlin CoroutineScope, Effection Scope
 */
export interface Scope {
  /** Spawn a child task within this scope */
  spawn<T>(computation: () => Eff<T, any>): Task<T>
  /** Cancel all children and close this scope */
  close(): void
  /** Whether this scope is still active */
  readonly active: boolean
  /** All active child tasks */
  readonly children: ReadonlySet<Task<any>>
}

// ============================================================================
// Built-in Effect Types
// ============================================================================

/** Effect to spawn a child task in the current scope */
export interface SpawnEffect
  extends Effect<'Spawn', { task: () => Eff<any, any> }, Task<any>> {
  readonly task: () => Eff<any, any>
}

/** Effect to cancel a running task */
export interface CancelEffect
  extends Effect<'Cancel', { taskId: TaskId }, void> {
  readonly taskId: TaskId
}

/** Effect to get the current scope */
export interface ScopeEffect extends Effect<'GetScope', {}, Scope> {}

/** Effect to sleep for a given number of milliseconds */
export interface SleepEffect
  extends Effect<'Sleep', { ms: number }, void> {
  readonly ms: number
}

// ============================================================================
// Error Effect Types
// ============================================================================

/**
 * A typed error effect.
 * Unlike JavaScript's untyped `throw`, this effect carries type information
 * so handlers can discriminate error types at compile time.
 */
export interface ErrorEffect<E = unknown>
  extends Effect<'Error', { error: E }, never> {
  readonly error: E
}

/**
 * Result type for computations that may fail.
 */
export type Result<A, E = unknown> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E }

export const Ok = <A>(value: A): Result<A, never> => ({
  ok: true,
  value,
})

export const Err = <E>(error: E): Result<never, E> => ({
  ok: false,
  error,
})
