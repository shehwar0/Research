// ============================================================================
// fx-ts — Task Groups: Structured Concurrency with Supervision
// ============================================================================
// Task groups provide scope-bound concurrent task execution with
// configurable supervision strategies.
//
// Theoretical basis:
//   - OCaml Eio (Sivaramakrishnan 2021): Switch + Fiber groups
//   - Kotlin CoroutineScope: supervisorScope, coroutineScope
//   - Python trio: Nursery pattern
//
// A TaskGroup is a scope-bound collection of concurrent tasks.
// When the group completes or fails, all tasks are cleaned up.
// The supervision strategy determines how failures propagate.
// ============================================================================

import type { Eff, EffectSignal, Task, TaskId, TaskStatus } from './types.js'
import { perform, createHandler, handleAsync } from './core.js'
import { createTask, createScope, ScopeImpl, CancellationError } from './concurrency.js'

// ============================================================================
// Supervision Strategies
// ============================================================================

/**
 * Supervision strategies determine how a TaskGroup handles child failures.
 *
 * - `failFast`: Cancel all siblings on first failure (default, strictest)
 * - `allSettled`: Wait for all tasks to complete, collect all results/errors
 * - `bestEffort`: Cancel remaining on first failure, but don't re-throw
 */
export type SupervisionStrategy = 'failFast' | 'allSettled' | 'bestEffort'

// ============================================================================
// Task Group Types
// ============================================================================

/**
 * The result of a supervised task within a group.
 */
export type TaskResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'cancelled' }

/**
 * A handle to a task within a task group.
 */
export interface GroupTask<T> {
  readonly id: TaskId
  readonly promise: Promise<T>
  readonly result: () => TaskResult<T> | undefined
}

/**
 * A TaskGroup manages a collection of concurrent tasks with structured
 * lifetime guarantees and supervision strategies.
 *
 * Key guarantees:
 *   1. All tasks are cancelled when the group scope closes
 *   2. The group waits for all tasks before returning
 *   3. Supervision strategy controls failure propagation
 */
export interface TaskGroup {
  /** Spawn a new task within this group */
  spawn<T>(computation: () => Eff<T, any>): GroupTask<T>
  /** Number of active tasks */
  readonly activeCount: number
  /** Whether the group is still accepting new tasks */
  readonly active: boolean
  /** Wait for all tasks to settle according to supervision strategy */
  readonly completion: Promise<TaskResult<any>[]>
}

// ============================================================================
// TaskGroup Implementation
// ============================================================================

class TaskGroupImpl implements TaskGroup {
  private _scope: ScopeImpl
  private _tasks: Map<TaskId, { task: Task<any>; result?: TaskResult<any> }> = new Map()
  private _active = true
  private _completionResolve!: (results: TaskResult<any>[]) => void
  private _completionReject!: (error: unknown) => void
  readonly completion: Promise<TaskResult<any>[]>

  constructor(
    private readonly _strategy: SupervisionStrategy,
    parentScope?: ScopeImpl,
  ) {
    this._scope = createScope(parentScope)
    this.completion = new Promise<TaskResult<any>[]>((resolve, reject) => {
      this._completionResolve = resolve
      this._completionReject = reject
    })
  }

  get active(): boolean {
    return this._active
  }

  get activeCount(): number {
    let count = 0
    for (const entry of this._tasks.values()) {
      if (!entry.result) count++
    }
    return count
  }

  spawn<T>(computation: () => Eff<T, any>): GroupTask<T> {
    if (!this._active) {
      throw new Error('fx: Cannot spawn in an inactive TaskGroup')
    }

    const task = this._scope.spawn(computation)
    const entry = { task, result: undefined as TaskResult<T> | undefined }
    this._tasks.set(task.id, entry)

    // Drive the generator for simple synchronous computations
    try {
      const gen = computation()
      const step = gen.next()
      if (step.done) {
        entry.result = { status: 'completed', value: step.value } as TaskResult<T>
        // Defer settlement check so all spawns can happen first
        queueMicrotask(() => this._onTaskSettled(task.id, entry.result!))
      }
    } catch (error) {
      entry.result = { status: 'failed', error }
      if (this._strategy === 'failFast') {
        // Fail immediately for failFast — don't defer
        queueMicrotask(() => this._onTaskSettled(task.id, entry.result!))
      } else {
        queueMicrotask(() => this._onTaskSettled(task.id, entry.result!))
      }
    }

    // Also listen for async completion via the task promise
    task.promise
      .then((value) => {
        if (!entry.result) {
          entry.result = { status: 'completed', value }
          this._onTaskSettled(task.id, entry.result)
        }
      })
      .catch((error) => {
        if (!entry.result) {
          if (error instanceof CancellationError) {
            entry.result = { status: 'cancelled' }
          } else {
            entry.result = { status: 'failed', error }
          }
          this._onTaskSettled(task.id, entry.result)
        }
      })

    return {
      id: task.id,
      promise: task.promise,
      result: () => entry.result,
    }
  }

  private _onTaskSettled(taskId: TaskId, result: TaskResult<any>): void {
    if (!this._active) return

    if (result.status === 'failed' && this._strategy === 'failFast') {
      this._active = false
      // Cancel all remaining tasks
      for (const [id, entry] of this._tasks) {
        if (id !== taskId && !entry.result) {
          entry.task.cancel()
          entry.result = { status: 'cancelled' }
        }
      }
      this._scope.close()
      this._completionReject(result.error)
      return
    }

    if (result.status === 'failed' && this._strategy === 'bestEffort') {
      // Cancel remaining but don't reject
      for (const [id, entry] of this._tasks) {
        if (id !== taskId && !entry.result) {
          entry.task.cancel()
          entry.result = { status: 'cancelled' }
        }
      }
    }

    // Check if all tasks are settled
    const allResults = Array.from(this._tasks.values())
    const isAllSettled = allResults.every((e) => e.result)
    if (isAllSettled) {
      this._active = false
      this._scope.close()
      const results = allResults.map((e) => e.result!)

      // For failFast, check if any task failed and reject with its error
      if (this._strategy === 'failFast') {
        const failed = results.find((r) => r.status === 'failed')
        if (failed && failed.status === 'failed') {
          this._completionReject(failed.error)
          return
        }
      }

      this._completionResolve(results)
    }
  }

  /**
   * Cancel all tasks and close the group.
   */
  close(): void {
    if (!this._active) return
    this._active = false

    for (const entry of this._tasks.values()) {
      if (!entry.result) {
        entry.task.cancel()
        entry.result = { status: 'cancelled' }
      }
    }

    this._scope.close()
    const results = Array.from(this._tasks.values()).map((e) => e.result!)
    this._completionResolve(results)
  }
}

// ============================================================================
// TaskGroup Construction
// ============================================================================

/**
 * Create a new TaskGroup with the given supervision strategy.
 *
 * @example
 * ```typescript
 * const group = createTaskGroup('failFast')
 *
 * group.spawn(function* () { return yield* fetchUser(1) })
 * group.spawn(function* () { return yield* fetchUser(2) })
 *
 * const results = await group.completion
 * ```
 */
export function createTaskGroup(
  strategy: SupervisionStrategy = 'failFast',
  parentScope?: ScopeImpl,
): TaskGroup & { close(): void } {
  return new TaskGroupImpl(strategy, parentScope)
}

// ============================================================================
// withTaskGroup — Scoped task group execution
// ============================================================================

/**
 * Run a computation with access to a TaskGroup.
 * The task group is created at the start and closed when the computation
 * completes (or fails). All spawned tasks are cleaned up.
 *
 * @example
 * ```typescript
 * const results = await withTaskGroup('failFast', async (group) => {
 *   group.spawn(function* () { return 'task1' })
 *   group.spawn(function* () { return 'task2' })
 * })
 * ```
 */
export async function withTaskGroup<R>(
  strategy: SupervisionStrategy,
  fn: (group: TaskGroup) => R | Promise<R>,
): Promise<TaskResult<any>[]> {
  const group = createTaskGroup(strategy)
  try {
    await fn(group)
    return await group.completion
  } catch (error) {
    group.close()
    throw error
  }
}

// ============================================================================
// Parallel combinators using TaskGroup
// ============================================================================

/**
 * Run multiple computations concurrently with structured supervision.
 *
 * Unlike the basic `all()` from concurrency.ts, this uses TaskGroup
 * for proper supervision and cancellation propagation.
 *
 * @example
 * ```typescript
 * const [user, orders] = await parallel(
 *   [
 *     function* () { return yield* fetchUser(1) },
 *     function* () { return yield* fetchOrders(1) },
 *   ],
 *   'failFast',
 * )
 * ```
 */
export async function parallel<T>(
  computations: (() => Eff<T, any>)[],
  strategy: SupervisionStrategy = 'failFast',
): Promise<TaskResult<T>[]> {
  const group = createTaskGroup(strategy)

  for (const comp of computations) {
    group.spawn(comp)
  }

  return group.completion
}

/**
 * Run computations with a concurrency limit.
 *
 * @example
 * ```typescript
 * const results = await parallelN(
 *   urls.map(url => function* () { return yield* fetchUrl(url) }),
 *   3, // max 3 concurrent
 * )
 * ```
 */
export async function parallelN<T>(
  computations: (() => Eff<T, any>)[],
  concurrency: number,
  strategy: SupervisionStrategy = 'failFast',
): Promise<TaskResult<T>[]> {
  const results: TaskResult<T>[] = new Array(computations.length)
  let index = 0

  async function worker(): Promise<void> {
    while (index < computations.length) {
      const i = index++
      const comp = computations[i]!
      try {
        const gen = comp()
        const step = gen.next()
        if (step.done) {
          results[i] = { status: 'completed', value: step.value }
        } else {
          // Effectful computation — mark as needing async driving
          results[i] = { status: 'failed', error: new Error('fx: parallelN requires pure computations or handled effects') }
        }
      } catch (error) {
        results[i] = { status: 'failed', error }
        if (strategy === 'failFast') throw error
      }
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, computations.length); i++) {
    workers.push(worker())
  }

  if (strategy === 'failFast') {
    await Promise.all(workers)
  } else {
    await Promise.allSettled(workers)
  }

  return results
}
