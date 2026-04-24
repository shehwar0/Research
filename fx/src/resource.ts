// ============================================================================
// fx-ts — Resource Management as Algebraic Effects
// ============================================================================
// Scoped resource lifecycle management using algebraic effects.
// Resources are acquired and released within a scope — when the scope
// closes, all resources are released in reverse acquisition order.
//
// Theoretical basis:
//   - OCaml Eio Switch: resource lifecycle bound to scope lifetime
//   - Kotlin CoroutineScope: structured resource management
//   - TC39 Explicit Resource Management: Symbol.dispose integration
//
// Key insight: Resource management IS an algebraic effect. The "acquire"
// and "release" operations are effects handled by the scope manager.
// This makes resource cleanup deterministic and composable.
// ============================================================================

import type { Eff, Effect, EffectSignal } from './types.js'
import { perform, createHandler } from './core.js'

// ============================================================================
// Resource Types
// ============================================================================

/**
 * A resource with an explicit lifecycle.
 *
 * Resources have:
 *   - `value`: The acquired resource value
 *   - `release`: A cleanup function called when the scope closes
 *
 * @example
 * ```typescript
 * const dbResource: Resource<DbConnection> = {
 *   value: connection,
 *   release: () => connection.close()
 * }
 * ```
 */
export interface Resource<T> {
  readonly value: T
  readonly release: () => void | Promise<void>
}

/**
 * A resource descriptor — instructions for acquiring and releasing a resource.
 */
export interface ResourceDescriptor<T> {
  readonly acquire: () => T | Promise<T>
  readonly release: (value: T) => void | Promise<void>
}

// ============================================================================
// Resource Effects
// ============================================================================

/**
 * Effect to acquire a scoped resource.
 * The resource will be automatically released when the scope closes.
 */
export interface AcquireEffect<T = unknown>
  extends Effect<'Acquire', { descriptor: ResourceDescriptor<T> }, T> {
  readonly descriptor: ResourceDescriptor<T>
}

/**
 * Effect to release a resource early (before scope close).
 */
export interface ReleaseEffect
  extends Effect<'Release', { resource: Resource<any> }, void> {
  readonly resource: Resource<any>
}

// ============================================================================
// Resource Performers
// ============================================================================

/**
 * Acquire a scoped resource using an algebraic effect.
 *
 * The resource is acquired when `using()` is performed and automatically
 * released when the enclosing scope closes — whether by normal completion,
 * failure, or cancellation.
 *
 * @example
 * ```typescript
 * function* readFile(path: string): Eff<string, AcquireEffect<FileHandle>> {
 *   const handle = yield* using({
 *     acquire: () => fs.open(path, 'r'),
 *     release: (h) => h.close(),
 *   })
 *   return handle.readFileSync('utf8')
 * }
 * ```
 */
export function* using<T>(
  descriptor: ResourceDescriptor<T>,
): Eff<T, AcquireEffect<T>> {
  return yield* perform<AcquireEffect<T>>({
    _tag: 'Acquire',
    descriptor,
  } as AcquireEffect<T>)
}

/**
 * Release a resource early, before the scope closes.
 */
export function* releaseEarly(
  resource: Resource<any>,
): Eff<void, ReleaseEffect> {
  return yield* perform<ReleaseEffect>({
    _tag: 'Release',
    resource,
  } as ReleaseEffect)
}

// ============================================================================
// bracket — Acquire/Use/Release Combinator
// ============================================================================

/**
 * Bracket pattern: acquire a resource, use it, and guarantee release.
 *
 * This is the algebraic effects equivalent of try-with-resources.
 * The resource is released even if the computation fails.
 *
 * @example
 * ```typescript
 * const contents = yield* bracket(
 *   () => openFile('data.txt'),         // acquire
 *   (file) => file.read(),              // use
 *   (file) => file.close(),             // release (always runs)
 * )
 * ```
 */
export function* bracket<T, R, E extends EffectSignal = never>(
  acquire: () => T,
  use: (resource: T) => Eff<R, E>,
  release: (resource: T) => void,
): Eff<R, E> {
  const resource = acquire()
  try {
    return yield* use(resource)
  } finally {
    release(resource)
  }
}

/**
 * Async bracket — like bracket but acquire and release can be async.
 */
export async function bracketAsync<T, R>(
  acquire: () => T | Promise<T>,
  use: (resource: T) => R | Promise<R>,
  release: (resource: T) => void | Promise<void>,
): Promise<R> {
  const resource = await acquire()
  try {
    return await use(resource)
  } finally {
    await release(resource)
  }
}

// ============================================================================
// Resource Scope — Tracks and releases resources
// ============================================================================

/**
 * A resource scope that tracks acquired resources and releases them
 * in reverse order when closed.
 *
 * This implements the LIFO (stack) resource release ordering that
 * is standard in structured resource management.
 */
export class ResourceScope {
  private _resources: Resource<any>[] = []
  private _closed = false

  get closed(): boolean {
    return this._closed
  }

  get count(): number {
    return this._resources.length
  }

  /**
   * Track a resource for automatic release.
   */
  track<T>(resource: Resource<T>): void {
    if (this._closed) {
      throw new Error('fx: Cannot track resource in a closed ResourceScope')
    }
    this._resources.push(resource)
  }

  /**
   * Release a specific resource and stop tracking it.
   */
  release(resource: Resource<any>): void {
    const index = this._resources.indexOf(resource)
    if (index >= 0) {
      this._resources.splice(index, 1)
      resource.release()
    }
  }

  /**
   * Close the scope — release all tracked resources in reverse order.
   * This is the key structured resource management guarantee.
   */
  close(): void {
    if (this._closed) return
    this._closed = true

    // Release in reverse acquisition order (LIFO)
    const errors: unknown[] = []
    for (let i = this._resources.length - 1; i >= 0; i--) {
      try {
        this._resources[i]!.release()
      } catch (e) {
        errors.push(e)
      }
    }
    this._resources = []

    if (errors.length > 0) {
      throw new AggregateResourceError(
        'fx: Errors during resource cleanup',
        errors,
      )
    }
  }

  /**
   * Close the scope asynchronously — for async release functions.
   */
  async closeAsync(): Promise<void> {
    if (this._closed) return
    this._closed = true

    const errors: unknown[] = []
    for (let i = this._resources.length - 1; i >= 0; i--) {
      try {
        await this._resources[i]!.release()
      } catch (e) {
        errors.push(e)
      }
    }
    this._resources = []

    if (errors.length > 0) {
      throw new AggregateResourceError(
        'fx: Errors during async resource cleanup',
        errors,
      )
    }
  }
}

export class AggregateResourceError extends Error {
  constructor(
    message: string,
    public readonly errors: unknown[],
  ) {
    super(`${message} (${errors.length} error(s))`)
    this.name = 'AggregateResourceError'
  }
}

// ============================================================================
// Resource Handler — handles Acquire/Release effects
// ============================================================================

/**
 * Create a handler that manages resource effects within a ResourceScope.
 *
 * @example
 * ```typescript
 * const scope = new ResourceScope()
 * const handler = resourceHandler(scope)
 *
 * run(() => handle(handler, function* () {
 *   const db = yield* using({
 *     acquire: () => connectDb(),
 *     release: (conn) => conn.close(),
 *   })
 *   return db.query('SELECT 1')
 * }))
 *
 * scope.close() // All resources released
 * ```
 */
export function resourceHandler(scope: ResourceScope) {
  return createHandler<AcquireEffect<any> | ReleaseEffect>({
    Acquire: (
      effect: AcquireEffect<any>,
      resume: (v: any) => void,
    ) => {
      const value = effect.descriptor.acquire()
      const resource: Resource<any> = {
        value,
        release: () => effect.descriptor.release(value),
      }
      scope.track(resource)
      resume(value)
    },
    Release: (
      effect: ReleaseEffect,
      resume: (v: any) => void,
    ) => {
      scope.release(effect.resource)
      resume(undefined)
    },
  } as any)
}

// ============================================================================
// Symbol.dispose Integration
// ============================================================================

/**
 * Create a Resource from a Disposable object (TC39 Explicit Resource Management).
 *
 * @example
 * ```typescript
 * const handle = yield* usingDisposable({
 *   [Symbol.dispose]: () => console.log('Disposed!')
 * })
 * ```
 */
export function* usingDisposable<T extends Disposable>(
  disposable: T,
): Eff<T, AcquireEffect<T>> {
  return yield* using({
    acquire: () => disposable,
    release: (d) => d[Symbol.dispose](),
  })
}

/**
 * Wrap a value with a cleanup function, matching TC39 Disposable protocol.
 */
export function disposable<T>(
  value: T,
  cleanup: (v: T) => void,
): T & Disposable {
  return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
    [Symbol.dispose]: () => cleanup(value),
  })
}
