// ============================================================================
// fx-ts — Interop: Bridge between Effects and Promises/Async
// ============================================================================
// Provides seamless integration with JavaScript's existing async ecosystem.
// The goal is to minimize the "function coloring" problem by providing
// ergonomic bridges in both directions.
// ============================================================================

import type { Eff, EffectSignal, Effect } from './types.js'
import { perform } from './core.js'

// ============================================================================
// Promise → Effect Bridge
// ============================================================================

/**
 * An effect that represents an asynchronous operation (Promise).
 * This bridges the gap between Promise-based code and the effect system.
 */
export interface AsyncEffect<T = unknown>
  extends Effect<'Async', { thunk: () => Promise<T> }, T> {
  readonly thunk: () => Promise<T>
}

/**
 * Lift a Promise-returning function into an algebraic effect.
 *
 * This allows calling async functions from within effect computations
 * without the "color" problem — the caller doesn't need to know
 * whether the underlying operation is sync or async.
 *
 * @example
 * ```typescript
 * function* fetchUser(id: number): Eff<User, AsyncEffect<User>> {
 *   const user = yield* fromPromise(() => fetch(`/api/users/${id}`).then(r => r.json()))
 *   return user
 * }
 * ```
 */
export function* fromPromise<T>(
  thunk: () => Promise<T>,
): Eff<T, AsyncEffect<T>> {
  return yield* perform<AsyncEffect<T>>({
    _tag: 'Async',
    thunk,
  } as AsyncEffect<T>)
}

/**
 * Lift a raw Promise into an algebraic effect.
 */
export function* fromPromiseValue<T>(
  promise: Promise<T>,
): Eff<T, AsyncEffect<T>> {
  return yield* fromPromise(() => promise)
}

// ============================================================================
// Effect → Promise Bridge
// ============================================================================

/**
 * Convert an effect computation to a Promise by providing a handler
 * for AsyncEffect.
 *
 * This is the primary bridge from effect-land to promise-land.
 *
 * @example
 * ```typescript
 * const user = await toPromise(function* () {
 *   return yield* fetchUser(42)
 * })
 * ```
 */
export function toPromise<T>(computation: () => Eff<T, AsyncEffect<any>>): Promise<T> {
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

        if (effect._tag === 'Async') {
          const asyncEffect = effect as AsyncEffect<any>
          asyncEffect
            .thunk()
            .then((value) => drive(value))
            .catch((error) => reject(error))
        } else {
          reject(
            new Error(
              `fx: Unhandled effect "${effect._tag}" in toPromise(). ` +
              'Only AsyncEffect is automatically handled.'
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
// Callback → Effect Bridge
// ============================================================================

/**
 * A callback effect for integrating with callback-based APIs.
 */
export interface CallbackEffect<T = unknown>
  extends Effect<'Callback', {}, T> {
  readonly register: (
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ) => (() => void) | void  // optional cleanup function
}

/**
 * Convert a callback-based API into an algebraic effect.
 *
 * @example
 * ```typescript
 * function* readFile(path: string): Eff<string, CallbackEffect<string>> {
 *   return yield* fromCallback((resolve, reject) => {
 *     fs.readFile(path, 'utf8', (err, data) => {
 *       if (err) reject(err)
 *       else resolve(data)
 *     })
 *   })
 * }
 * ```
 */
export function* fromCallback<T>(
  register: (
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ) => (() => void) | void,
): Eff<T, CallbackEffect<T>> {
  return yield* perform<CallbackEffect<T>>({
    _tag: 'Callback',
    register,
  } as CallbackEffect<T>)
}

// ============================================================================
// AbortSignal Integration
// ============================================================================

/**
 * An effect to get the current AbortSignal for cancellation integration.
 */
export interface AbortSignalEffect
  extends Effect<'AbortSignal', {}, AbortSignal> {}

/**
 * Get an AbortSignal that is cancelled when the current scope is cancelled.
 *
 * This bridges structured concurrency with the AbortController pattern
 * used by fetch(), WebSocket, etc.
 *
 * @example
 * ```typescript
 * function* fetchWithCancel(url: string): Eff<Response, AbortSignalEffect | AsyncEffect<Response>> {
 *   const signal = yield* useAbortSignal()
 *   return yield* fromPromise(() => fetch(url, { signal }))
 * }
 * ```
 */
export function* useAbortSignal(): Eff<AbortSignal, AbortSignalEffect> {
  return yield* perform<AbortSignalEffect>({
    _tag: 'AbortSignal',
  } as AbortSignalEffect)
}

// ============================================================================
// Async handler — handles AsyncEffect, CallbackEffect, AbortSignalEffect
// ============================================================================

import { createHandler } from './core.js'

/**
 * A handler that resolves AsyncEffect by running the thunk.
 * Used internally by toPromise() and runAsync().
 */
export const asyncHandler = createHandler<AsyncEffect<any>>({
  Async: (effect: AsyncEffect<any>, resume: (v: any) => void) => {
    effect.thunk().then(
      (value: any) => resume(value),
      (error: any) => { throw error }
    )
  },
} as any)

/**
 * A handler that resolves CallbackEffect.
 */
export const callbackHandler = createHandler<CallbackEffect<any>>({
  Callback: (effect: CallbackEffect<any>, resume: (v: any) => void) => {
    effect.register(
      (value: any) => resume(value),
      (error: any) => { throw error },
    )
  },
} as any)

