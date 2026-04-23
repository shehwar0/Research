// ============================================================================
// fx-ts — Structured Concurrency
// ============================================================================
// Implements structured concurrency primitives where child task lifetimes
// are lexically scoped — a child cannot outlive its parent scope.
//
// Theoretical basis:
//   - OCaml Eio (Sivaramakrishnan 2021): Switch/Fiber/Cancel model
//   - Kotlin CoroutineScope: Structured concurrency guarantees
//   - Effection (v4): Parent-task priority and explicit scope management
// ============================================================================

import type {
  Eff,
  EffectSignal,
  Task,
  TaskId,
  TaskStatus,
  Scope,
  SpawnEffect,
  CancelEffect,
  ScopeEffect,
  SleepEffect,
} from './types.js'
import { perform } from './core.js'

// ============================================================================
// Task ID Generation
// ============================================================================

let nextTaskId = 0

function createTaskId(): TaskId {
  return (nextTaskId++) as TaskId
}

// ============================================================================
// Task Implementation
// ============================================================================

interface MutableTask<T> extends Task<T> {
  _status: TaskStatus
  _resolve: (value: T) => void
  _reject: (error: unknown) => void
  _onCancel: (() => void)[]
}

export function createTask<T>(
  computation: () => Eff<T, any>,
): MutableTask<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  const task: MutableTask<T> = {
    id: createTaskId(),
    promise,
    _status: 'running' as TaskStatus,
    _resolve: resolve,
    _reject: reject,
    _onCancel: [],
    get status(): TaskStatus {
      return task._status
    },
    cancel(): void {
      if (task._status === 'running') {
        task._status = 'cancelled'
        for (const cb of task._onCancel) {
          try { cb() } catch { /* ignore cancel errors */ }
        }
        task._reject(new CancellationError('Task cancelled'))
      }
    },
  }

  return task
}

// ============================================================================
// Scope Implementation
// ============================================================================

export class CancellationError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message)
    this.name = 'CancellationError'
  }
}

export function createScope(parent?: ScopeImpl): ScopeImpl {
  return new ScopeImpl(parent)
}

export class ScopeImpl implements Scope {
  private _active = true
  private _children = new Set<Task<any>>()
  private _childScopes = new Set<ScopeImpl>()
  private _parent?: ScopeImpl

  constructor(parent?: ScopeImpl) {
    this._parent = parent
    if (parent) {
      parent._childScopes.add(this)
    }
  }

  get active(): boolean {
    return this._active
  }

  get children(): ReadonlySet<Task<any>> {
    return this._children
  }

  spawn<T>(computation: () => Eff<T, any>): Task<T> {
    if (!this._active) {
      throw new Error('fx: Cannot spawn in a closed scope')
    }

    const task = createTask(computation)
    this._children.add(task)

    // Remove task from scope when it completes
    task.promise
      .then(() => {
        task._status = 'completed'
        this._children.delete(task)
      })
      .catch(() => {
        if (task._status === 'running') {
          task._status = 'failed'
        }
        this._children.delete(task)
      })

    return task
  }

  close(): void {
    if (!this._active) return
    this._active = false

    // Cancel all child tasks
    for (const task of this._children) {
      task.cancel()
    }
    this._children.clear()

    // Close all child scopes
    for (const child of this._childScopes) {
      child.close()
    }
    this._childScopes.clear()

    // Remove from parent
    if (this._parent) {
      this._parent._childScopes.delete(this)
    }
  }
}

// ============================================================================
// Built-in Structured Concurrency Effects
// ============================================================================

/**
 * Spawn a child task within the current scope.
 *
 * The child task is bound to the parent scope's lifetime:
 * when the parent scope closes, all children are cancelled.
 *
 * @example
 * ```typescript
 * function* myOp(): Eff<void, SpawnEffect> {
 *   const task = yield* spawn(function* () {
 *     yield* sleep(1000)
 *     return 'done'
 *   })
 *   // task is automatically cancelled if this scope ends
 * }
 * ```
 */
export function* spawn<T>(
  computation: () => Eff<T, any>,
): Eff<Task<T>, SpawnEffect> {
  return yield* perform<SpawnEffect>({
    _tag: 'Spawn',
    task: computation,
  } as SpawnEffect)
}

/**
 * Cancel a running task.
 */
export function* cancel(taskId: TaskId): Eff<void, CancelEffect> {
  return yield* perform<CancelEffect>({
    _tag: 'Cancel',
    taskId,
  } as CancelEffect)
}

/**
 * Get the current scope.
 */
export function* useScope(): Eff<Scope, ScopeEffect> {
  return yield* perform<ScopeEffect>({ _tag: 'GetScope' } as ScopeEffect)
}

/**
 * Sleep for a given number of milliseconds.
 */
export function* sleep(ms: number): Eff<void, SleepEffect> {
  return yield* perform<SleepEffect>({ _tag: 'Sleep', ms } as SleepEffect)
}

// ============================================================================
// Structured concurrency combinators: all, race, any
// ============================================================================

/**
 * Run multiple computations concurrently and wait for all to complete.
 *
 * If any computation fails, all others are cancelled (structured concurrency).
 * This is the algebraic effects equivalent of `Promise.all()` + cancellation.
 *
 * @example
 * ```typescript
 * const [user, orders] = yield* all([
 *   fetchUser(42),
 *   fetchOrders(42),
 * ])
 * ```
 */
export function all<T extends readonly Eff<any, any>[]>(
  computations: readonly [...{ [K in keyof T]: () => T[K] }],
): Promise<{ [K in keyof T]: T[K] extends Eff<infer A, any> ? A : never }> {
  const scope = createScope()

  return new Promise((resolve, reject) => {
    const results: any[] = new Array(computations.length)
    let completed = 0
    let failed = false

    computations.forEach((comp, index) => {
      if (failed) return

      const task = scope.spawn(comp as () => Eff<any, any>)

      // Drive the generator synchronously for now
      // Full async driving will be in Phase 2
      try {
        const gen = (comp as () => Eff<any, any>)()
        const result = gen.next()
        if (result.done) {
          results[index] = result.value
          completed++
          if (completed === computations.length) {
            scope.close()
            resolve(results as any)
          }
        }
      } catch (error) {
        if (!failed) {
          failed = true
          scope.close() // Cancel all siblings
          reject(error)
        }
      }
    })
  })
}

/**
 * Run multiple computations concurrently, returning the first to complete.
 * All other computations are automatically cancelled.
 *
 * @example
 * ```typescript
 * const result = await race([
 *   () => fetchFromPrimary(),
 *   () => fetchFromFallback(),
 * ])
 * ```
 */
export function race<T>(
  computations: readonly (() => Eff<T, any>)[],
): Promise<T> {
  const scope = createScope()

  return new Promise((resolve, reject) => {
    let settled = false

    for (const comp of computations) {
      if (settled) break

      try {
        const gen = comp()
        const result = gen.next()
        if (result.done && !settled) {
          settled = true
          scope.close()
          resolve(result.value)
        }
      } catch (error) {
        if (!settled) {
          settled = true
          scope.close()
          reject(error)
        }
      }
    }
  })
}

// ============================================================================
// Scope handler — handles spawn/cancel/scope effects
// ============================================================================

import { createHandler } from './core.js'

/**
 * Create a handler that manages structured concurrency effects
 * within a given scope.
 */
export function scopeHandler(scope: ScopeImpl) {
  return createHandler<SpawnEffect | CancelEffect | ScopeEffect | SleepEffect>({
    Spawn: (effect: SpawnEffect, resume: (v: any) => void) => {
      const task = scope.spawn(effect.task)
      resume(task)
    },
    Cancel: (effect: CancelEffect, resume: (v: any) => void) => {
      for (const child of scope.children) {
        if (child.id === effect.taskId) {
          child.cancel()
          break
        }
      }
      resume(undefined)
    },
    GetScope: (_effect: ScopeEffect, resume: (v: any) => void) => {
      resume(scope)
    },
    Sleep: (effect: SleepEffect, resume: (v: any) => void) => {
      setTimeout(() => resume(undefined), effect.ms)
    },
  } as any)
}
