// ============================================================================
// fx-ts — Asynchronous Effects (Ahman & Pretnar λ_ae Model)
// ============================================================================
// Implements non-blocking effect signaling based on the λ_ae calculus.
//
// Theoretical basis:
//   - Ahman & Pretnar (LMCS 2024): "Asynchronous Effects"
//   - The λ_ae calculus decomposes effect invocation into three phases:
//     1. SIGNAL — Notify the handler that work is needed
//     2. EXECUTE — Handler performs the work (potentially async)
//     3. INTERRUPT — Resume the computation with the result
//
// Key insight: Traditional algebraic effects BLOCK at the perform site
// until the handler resumes. Async effects DECOUPLE signaling from
// execution — the computation can continue with other work while
// the effect is being handled, then collect results when needed.
//
// This enables:
//   - Concurrent effect execution without spawning explicit fibers
//   - Prefetching / speculative execution
//   - Pipeline parallelism (signal many, await when needed)
// ============================================================================

import type { Eff, Effect, EffectSignal } from './types.js'
import { perform, createHandler } from './core.js'

// ============================================================================
// Async Handle — Deferred Effect Result
// ============================================================================

/**
 * An AsyncHandle represents a deferred effect result.
 *
 * When you signal an async effect, you get back a handle immediately.
 * The effect is being executed in the background. When you need the
 * result, you await the handle.
 *
 * This is the core of the signal/execute/interrupt model.
 */
export class AsyncHandle<T> {
  private _value: T | undefined
  private _error: unknown | undefined
  private _settled = false
  private _waiters: ((value: T) => void)[] = []
  private _errorWaiters: ((error: unknown) => void)[] = []

  /**
   * Whether the async effect has completed.
   */
  get settled(): boolean {
    return this._settled
  }

  /**
   * Resolve this handle with a value (INTERRUPT phase).
   * @internal
   */
  resolve(value: T): void {
    if (this._settled) return
    this._settled = true
    this._value = value
    for (const waiter of this._waiters) {
      waiter(value)
    }
    this._waiters = []
    this._errorWaiters = []
  }

  /**
   * Reject this handle with an error.
   * @internal
   */
  reject(error: unknown): void {
    if (this._settled) return
    this._settled = true
    this._error = error
    for (const waiter of this._errorWaiters) {
      waiter(error)
    }
    this._waiters = []
    this._errorWaiters = []
  }

  /**
   * Get the value if already settled, or undefined.
   */
  peek(): T | undefined {
    return this._value
  }

  /**
   * Convert to a Promise for interop.
   */
  toPromise(): Promise<T> {
    if (this._settled) {
      return this._error !== undefined
        ? Promise.reject(this._error)
        : Promise.resolve(this._value as T)
    }

    return new Promise<T>((resolve, reject) => {
      this._waiters.push(resolve)
      this._errorWaiters.push(reject)
    })
  }
}

// ============================================================================
// Async Effect Types
// ============================================================================

/**
 * Effect to SIGNAL an asynchronous operation.
 * Returns immediately with an AsyncHandle.
 */
export interface SignalAsyncEffect<T = unknown>
  extends Effect<'SignalAsync', { operation: AsyncOperation<T> }, AsyncHandle<T>> {
  readonly operation: AsyncOperation<T>
}

/**
 * Effect to AWAIT a previously signaled async result.
 * Blocks until the handle is resolved.
 */
export interface AwaitHandleEffect<T = unknown>
  extends Effect<'AwaitHandle', { handle: AsyncHandle<T> }, T> {
  readonly handle: AsyncHandle<T>
}

/**
 * An async operation descriptor — the work to be executed by the handler.
 */
export interface AsyncOperation<T> {
  readonly _tag: string
  readonly execute: () => Promise<T>
}

// ============================================================================
// Async Effect Performers
// ============================================================================

/**
 * Signal an asynchronous effect — returns immediately with a handle.
 *
 * The effect is NOT blocking. The handler begins executing the operation
 * in the background. The computation continues immediately.
 *
 * @example
 * ```typescript
 * function* prefetchAll(urls: string[]): Eff<Response[], SignalAsyncEffect<Response>> {
 *   // Signal all fetches — they start executing in parallel
 *   const handles = []
 *   for (const url of urls) {
 *     handles.push(yield* signalAsync({
 *       _tag: 'Fetch',
 *       execute: () => fetch(url),
 *     }))
 *   }
 *
 *   // Now await all results
 *   const results = []
 *   for (const h of handles) {
 *     results.push(yield* awaitHandle(h))
 *   }
 *   return results
 * }
 * ```
 */
export function* signalAsync<T>(
  operation: AsyncOperation<T>,
): Eff<AsyncHandle<T>, SignalAsyncEffect<T>> {
  return yield* perform<SignalAsyncEffect<T>>({
    _tag: 'SignalAsync',
    operation,
  } as SignalAsyncEffect<T>)
}

/**
 * Await the result of a previously signaled async effect.
 *
 * If the effect has already completed, returns immediately.
 * Otherwise, blocks until the result is available.
 */
export function* awaitHandle<T>(
  handle: AsyncHandle<T>,
): Eff<T, AwaitHandleEffect<T>> {
  // Fast path: if already settled, return immediately
  if (handle.settled) {
    const value = handle.peek()
    if (value !== undefined) {
      return value
    }
  }
  return yield* perform<AwaitHandleEffect<T>>({
    _tag: 'AwaitHandle',
    handle,
  } as AwaitHandleEffect<T>)
}

// ============================================================================
// Async Effect Handler
// ============================================================================

/**
 * Create a handler for the signal/execute/interrupt lifecycle.
 *
 * This handler:
 *   - On SignalAsync: starts executing the operation and returns the handle
 *   - On AwaitHandle: waits for the handle to resolve
 *
 * @example
 * ```typescript
 * const handler = asyncEffectHandler()
 *
 * const result = await runAsyncEffects(handler, function* () {
 *   const h1 = yield* signalAsync({ _tag: 'fetch', execute: () => fetch('/a') })
 *   const h2 = yield* signalAsync({ _tag: 'fetch', execute: () => fetch('/b') })
 *   // Both fetches are running in parallel!
 *   const r1 = yield* awaitHandle(h1)
 *   const r2 = yield* awaitHandle(h2)
 *   return [r1, r2]
 * })
 * ```
 */
export function asyncEffectHandler() {
  return createHandler<SignalAsyncEffect<any> | AwaitHandleEffect<any>>({
    SignalAsync: (
      effect: SignalAsyncEffect<any>,
      resume: (v: any) => void,
    ) => {
      const handle = new AsyncHandle<any>()
      // EXECUTE phase: start the async operation
      effect.operation
        .execute()
        .then((value) => handle.resolve(value))
        .catch((error) => handle.reject(error))
      // SIGNAL phase complete: return the handle immediately
      resume(handle)
    },
    AwaitHandle: (
      effect: AwaitHandleEffect<any>,
      resume: (v: any) => void,
    ) => {
      const handle = effect.handle
      if (handle.settled) {
        // Already done — resume immediately
        resume(handle.peek())
      } else {
        // Wait for completion — INTERRUPT phase
        handle.toPromise().then(
          (value) => resume(value),
        )
      }
    },
  } as any)
}

// ============================================================================
// runAsyncEffects — Drive async effect computations
// ============================================================================

/**
 * Run a computation with async effects (signal/await).
 *
 * Returns a Promise that resolves when the computation completes.
 */
export function runAsyncEffects<T>(
  computation: () => Eff<T, SignalAsyncEffect<any> | AwaitHandleEffect<any>>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const gen = computation()
    const handler = asyncEffectHandler()

    function drive(input: any): void {
      try {
        const step = gen.next(input)

        if (step.done) {
          resolve(step.value)
          return
        }

        const effect = step.value as EffectSignal

        if (handler.handles(effect)) {
          handler.handle(effect as any, (value: any) => {
            // Use microtask to avoid stack overflow on long chains
            queueMicrotask(() => drive(value))
          })
        } else {
          reject(
            new Error(
              `fx: Unhandled effect "${effect._tag}" in runAsyncEffects.`,
            ),
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
// Pipeline Combinator — Signal many, await all
// ============================================================================

/**
 * Execute multiple async operations with pipeline parallelism.
 *
 * Signals all operations first (starting them in parallel),
 * then awaits all results.
 *
 * @example
 * ```typescript
 * const results = yield* pipeline([
 *   { _tag: 'fetch', execute: () => fetch('/api/users') },
 *   { _tag: 'fetch', execute: () => fetch('/api/orders') },
 * ])
 * ```
 */
export function* pipeline<T>(
  operations: AsyncOperation<T>[],
): Eff<T[], SignalAsyncEffect<T> | AwaitHandleEffect<T>> {
  // Signal phase — start all operations
  const handles: AsyncHandle<T>[] = []
  for (const op of operations) {
    handles.push(yield* signalAsync(op))
  }

  // Await phase — collect all results
  const results: T[] = []
  for (const h of handles) {
    results.push(yield* awaitHandle(h))
  }

  return results
}
