// ============================================================================
// fx-ts — Error Handling as Algebraic Effects
// ============================================================================
// Typed error channels using algebraic effects.
// Unlike JavaScript's untyped throw/catch, errors are tracked in the
// type system via the effect row.
//
// Three error categories:
//   1. Expected errors (typed) — handled via ErrorEffect<E>
//   2. Unexpected errors (defects) — propagate as exceptions
//   3. Interruption errors — from cancellation (CancellationError)
// ============================================================================

import type { Eff, EffectSignal, Effect, Result } from './types.js'
import { Ok, Err } from './types.js'
import { perform } from './core.js'

// ============================================================================
// Typed Error Effects
// ============================================================================

/**
 * A typed failure effect. This is the algebraic effect equivalent of
 * `throw`, but with full type tracking.
 *
 * Unlike JavaScript's `throw` which destroys the call stack irreversibly,
 * a Fail effect can be intercepted by a handler that may choose to:
 *   1. Resume with a fallback value
 *   2. Re-raise a different error
 *   3. Log and continue
 */
export interface FailEffect<E = unknown>
  extends Effect<'Fail', { error: E }, never> {
  readonly error: E
}

/**
 * Raise a typed error as an algebraic effect.
 *
 * @example
 * ```typescript
 * interface NotFoundError {
 *   readonly _tag: 'NotFound'
 *   readonly id: number
 * }
 *
 * function* getUser(id: number): Eff<User, FailEffect<NotFoundError> | FetchEffect> {
 *   const user = yield* fetchUser(id)
 *   if (!user) {
 *     yield* fail<NotFoundError>({ _tag: 'NotFound', id })
 *   }
 *   return user
 * }
 * ```
 */
export function* fail<E>(error: E): Eff<never, FailEffect<E>> {
  yield* perform<FailEffect<E>>({
    _tag: 'Fail',
    error,
  } as FailEffect<E>)
  // Unreachable — the handler will catch the Fail effect and abort
  throw new Error('fx: Unhandled Fail effect — this should never be reached')
}

// ============================================================================
// Error Handlers
// ============================================================================

/**
 * Handle errors by converting them to Result values.
 *
 * This handler catches FailEffect and wraps the computation
 * result in `Ok` or `Err`.
 *
 * @example
 * ```typescript
 * const result: Result<User, NotFoundError> = yield* catchFail(
 *   function* () { return yield* getUser(42) }
 * )
 * if (!result.ok) {
 *   console.log('Not found:', result.error.id)
 * }
 * ```
 */
export function* catchFail<A, E, R extends EffectSignal = never>(
  computation: () => Eff<A, FailEffect<E> | R>,
): Eff<Result<A, E>, R> {
  // We implement this by wrapping the computation and catching FailEffect
  const gen = computation()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return Ok(step.value) as Result<A, E>
    }

    const effect = step.value as EffectSignal

    if (effect._tag === 'Fail') {
      return Err((effect as FailEffect<E>).error) as Result<A, E>
    }

    // Bubble up other effects
    input = yield effect as any
  }
}

/**
 * Handle errors with a recovery function.
 *
 * If the computation fails, the recovery function is called with the
 * error and can return a fallback value.
 *
 * @example
 * ```typescript
 * const user = yield* recover(
 *   function* () { return yield* getUser(42) },
 *   (error) => ({ id: 0, name: 'Guest' })
 * )
 * ```
 */
export function* recover<A, E, R extends EffectSignal = never>(
  computation: () => Eff<A, FailEffect<E> | R>,
  onError: (error: E) => A,
): Eff<A, R> {
  const result = yield* catchFail<A, E, R>(computation)
  if (result.ok) {
    return result.value
  }
  return onError(result.error)
}

/**
 * Handle errors with an effectful recovery function.
 *
 * @example
 * ```typescript
 * const user = yield* recoverWith(
 *   function* () { return yield* getUser(42) },
 *   function* (error) {
 *     yield* perform<LogEffect>({ _tag: 'Log', msg: `Fallback for ${error.id}` })
 *     return { id: 0, name: 'Guest' }
 *   }
 * )
 * ```
 */
export function* recoverWith<A, E, R extends EffectSignal = never>(
  computation: () => Eff<A, FailEffect<E> | R>,
  onError: (error: E) => Eff<A, R>,
): Eff<A, R> {
  const result = yield* catchFail<A, E, R>(computation)
  if (result.ok) {
    return result.value
  }
  return yield* onError(result.error)
}

/**
 * Map errors from one type to another.
 *
 * Useful for translating domain errors across module boundaries.
 */
export function* mapError<A, E1, E2, R extends EffectSignal = never>(
  computation: () => Eff<A, FailEffect<E1> | R>,
  f: (error: E1) => E2,
): Eff<A, FailEffect<E2> | R> {
  const result = yield* catchFail<A, E1, R>(computation)
  if (result.ok) {
    return result.value
  }
  return yield* fail(f(result.error))
}

/**
 * Ensure a cleanup function runs regardless of success or failure.
 *
 * This is the algebraic effects equivalent of `try/finally`.
 */
export function* ensure<A, R extends EffectSignal = never>(
  computation: () => Eff<A, R>,
  cleanup: () => Eff<void, R>,
): Eff<A, R> {
  let result: A
  try {
    result = yield* computation()
  } finally {
    yield* cleanup()
  }
  return result
}

// ============================================================================
// Retry combinators
// ============================================================================

/**
 * Retry a computation up to `maxAttempts` times on failure.
 *
 * @example
 * ```typescript
 * const user = yield* retry(
 *   3,
 *   function* () { return yield* fetchUser(42) }
 * )
 * ```
 */
export function* retry<A, E, R extends EffectSignal = never>(
  maxAttempts: number,
  computation: () => Eff<A, FailEffect<E> | R>,
): Eff<A, FailEffect<E> | R> {
  let lastError: E | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = yield* catchFail<A, E, R>(computation)
    if (result.ok) {
      return result.value
    }
    lastError = result.error
  }

  // All attempts exhausted — raise the last error
  return yield* fail(lastError as E)
}
