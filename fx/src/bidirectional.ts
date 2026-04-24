// ============================================================================
// fx-ts — Bidirectional Effects (Zhang et al. 2020)
// ============================================================================
// Bidirectional control flow combining async iterators with effect handlers.
//
// Theoretical basis:
//   - Zhang et al. (OOPSLA 2020): "Handling Bidirectional Control Flow"
//   - Extends algebraic effects with bidirectional communication where
//     the computation can both YIELD values upstream AND PERFORM effects
//     at the same time.
//
// Key insight: Standard algebraic effects are unidirectional —
// the computation performs effects and the handler provides values.
// Bidirectional effects add a second channel where the computation
// can also yield intermediate values to the consumer while
// performing effects for its dependencies.
//
// This naturally models:
//   - Streaming producers that need resources (file reads → yield lines)
//   - Event handlers that emit events while performing I/O
//   - Coroutine-based protocols (request/response interleaving)
//   - Parser combinators that consume input and emit tokens
// ============================================================================

import type {
  Eff,
  Effect,
  EffectSignal,
  EffectReturn,
} from './types.js'
import { perform, createHandler } from './core.js'

// ============================================================================
// EffectStream — Bidirectional Effect + Yield
// ============================================================================

/**
 * A yield effect — the computation yields a value upstream.
 * This is the "bidirectional" channel in addition to normal effects.
 */
export interface YieldEffect<T = unknown>
  extends Effect<'Yield', { value: T }, void> {
  readonly value: T
}

/**
 * An EffectStream represents a bidirectional computation:
 *   - It PERFORMS effects (requesting values from handlers)
 *   - It YIELDS values upstream (producing results incrementally)
 *   - It returns a final value when complete
 *
 * This is the algebraic effect analog of an async generator/iterator.
 *
 * @typeParam V - The type of values yielded upstream
 * @typeParam A - The final return type
 * @typeParam E - The effect row (effects performed)
 */
export type EffectStream<V, A, E extends EffectSignal = never> =
  Eff<A, YieldEffect<V> | E>

// ============================================================================
// Bidirectional Performers
// ============================================================================

/**
 * Yield a value upstream within an effect stream.
 *
 * @example
 * ```typescript
 * function* readLines(path: string): EffectStream<string, void, ReadEffect> {
 *   const content = yield* perform<ReadEffect>({ _tag: 'Read', path })
 *   for (const line of content.split('\n')) {
 *     yield* yieldValue(line)  // Send each line upstream
 *   }
 * }
 * ```
 */
export function* yieldValue<T>(value: T): Eff<void, YieldEffect<T>> {
  return yield* perform<YieldEffect<T>>({
    _tag: 'Yield',
    value,
  } as YieldEffect<T>)
}

/**
 * Yield all values from an iterable.
 */
export function* yieldAll<T>(values: Iterable<T>): Eff<void, YieldEffect<T>> {
  for (const v of values) {
    yield* yieldValue(v)
  }
}

// ============================================================================
// Stream Consumers — Handle YieldEffect
// ============================================================================

/**
 * Consume an effect stream, collecting all yielded values.
 *
 * The yield effects are handled (consumed), and remaining effects
 * bubble up to outer handlers.
 *
 * @example
 * ```typescript
 * const lines: string[] = yield* collectStream(function* () {
 *   yield* yieldValue('hello')
 *   yield* yieldValue('world')
 * })
 * // lines === ['hello', 'world']
 * ```
 */
export function* collectStream<V, A, E extends EffectSignal = never>(
  stream: () => EffectStream<V, A, E>,
): Eff<{ values: V[]; result: A }, E> {
  const values: V[] = []
  const gen = stream()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return { values, result: step.value }
    }

    const effect = step.value as EffectSignal

    if (effect._tag === 'Yield') {
      values.push((effect as YieldEffect<V>).value)
      input = undefined // resume the yield
    } else {
      // Bubble up non-yield effects
      input = yield effect as any
    }
  }
}

/**
 * Consume an effect stream by calling a function for each yielded value.
 *
 * @example
 * ```typescript
 * yield* forEachEffect(
 *   function* () {
 *     yield* yieldValue(1)
 *     yield* yieldValue(2)
 *     yield* yieldValue(3)
 *   },
 *   (value) => console.log(value),
 * )
 * ```
 */
export function* forEachEffect<V, A, E extends EffectSignal = never>(
  stream: () => EffectStream<V, A, E>,
  onValue: (value: V) => void,
): Eff<A, E> {
  const gen = stream()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (effect._tag === 'Yield') {
      onValue((effect as YieldEffect<V>).value)
      input = undefined
    } else {
      input = yield effect as any
    }
  }
}

/**
 * Transform yielded values in an effect stream.
 *
 * @example
 * ```typescript
 * const doubled = mapStream(
 *   function* () {
 *     yield* yieldValue(1)
 *     yield* yieldValue(2)
 *   },
 *   (x) => x * 2,
 * )
 * // yields 2, 4
 * ```
 */
export function* mapStream<V1, V2, A, E extends EffectSignal = never>(
  stream: () => EffectStream<V1, A, E>,
  f: (value: V1) => V2,
): EffectStream<V2, A, E> {
  const gen = stream()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (effect._tag === 'Yield') {
      const mapped = f((effect as YieldEffect<V1>).value)
      yield* yieldValue(mapped)
      input = undefined
    } else {
      input = yield effect as any
    }
  }
}

/**
 * Filter yielded values in an effect stream.
 */
export function* filterStream<V, A, E extends EffectSignal = never>(
  stream: () => EffectStream<V, A, E>,
  predicate: (value: V) => boolean,
): EffectStream<V, A, E> {
  const gen = stream()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (effect._tag === 'Yield') {
      const value = (effect as YieldEffect<V>).value
      if (predicate(value)) {
        yield* yieldValue(value)
      }
      input = undefined
    } else {
      input = yield effect as any
    }
  }
}

/**
 * Take only the first N yielded values from a stream.
 */
export function* takeStream<V, A, E extends EffectSignal = never>(
  stream: () => EffectStream<V, A, E>,
  n: number,
): EffectStream<V, A | undefined, E> {
  const gen = stream()
  let input: any = undefined
  let count = 0

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (effect._tag === 'Yield') {
      if (count < n) {
        yield* yieldValue((effect as YieldEffect<V>).value)
        count++
      }
      if (count >= n) {
        return undefined // Early termination
      }
      input = undefined
    } else {
      input = yield effect as any
    }
  }
}

// ============================================================================
// Stream Composition
// ============================================================================

/**
 * Chain two effect streams: run the first, then the second.
 * Yields from both are forwarded.
 */
export function* chainStream<V, A, B, E extends EffectSignal = never>(
  first: () => EffectStream<V, A, E>,
  second: (a: A) => EffectStream<V, B, E>,
): EffectStream<V, B, E> {
  const a = yield* pipeThrough(first)
  return yield* pipeThrough(() => second(a))
}

/**
 * Run a stream and forward all its yields, returning its final value.
 * This is the "pass-through" for stream composition.
 */
function* pipeThrough<V, A, E extends EffectSignal = never>(
  stream: () => EffectStream<V, A, E>,
): EffectStream<V, A, E> {
  const gen = stream()
  let input: any = undefined

  while (true) {
    const step = gen.next(input)

    if (step.done) {
      return step.value
    }

    const effect = step.value as EffectSignal

    if (effect._tag === 'Yield') {
      yield* yieldValue((effect as YieldEffect<V>).value)
      input = undefined
    } else {
      input = yield effect as any
    }
  }
}

// ============================================================================
// Async Iterator Integration
// ============================================================================

/**
 * Convert an effect stream to an async iterable.
 *
 * This bridges effect streams with JavaScript's native async iteration,
 * enabling `for await (const value of stream)` syntax.
 *
 * Note: Effects in the stream must be fully handled before converting.
 */
export function toAsyncIterable<V>(
  stream: () => EffectStream<V, any, never>,
): AsyncIterable<V> {
  return {
    [Symbol.asyncIterator]() {
      const gen = stream()
      let done = false

      return {
        async next(): Promise<IteratorResult<V>> {
          if (done) return { done: true, value: undefined }

          while (true) {
            const step = gen.next(undefined)

            if (step.done) {
              done = true
              return { done: true, value: undefined }
            }

            const effect = step.value as EffectSignal

            if (effect._tag === 'Yield') {
              return {
                done: false,
                value: (effect as YieldEffect<V>).value,
              }
            }

            // Non-yield effects in a "pure" stream shouldn't happen
            throw new Error(
              `fx: Unhandled effect "${effect._tag}" in toAsyncIterable. ` +
              'Handle all effects before converting to async iterable.',
            )
          }
        },
      }
    },
  }
}

/**
 * Convert a native async iterable to an effect stream.
 */
export function* fromAsyncIterable<V>(
  iterable: AsyncIterable<V>,
): EffectStream<V, void, never> {
  // Note: This requires async handling to truly iterate.
  // For synchronous simulation, we accept an array-like.
  // Full async support requires Phase 4 WasmFX async fibers.
  throw new Error(
    'fx: fromAsyncIterable requires async effect handling. ' +
    'Use fromIterable() for synchronous iterables.',
  )
}

/**
 * Convert a synchronous iterable to an effect stream.
 */
export function* fromIterable<V>(
  iterable: Iterable<V>,
): EffectStream<V, void, never> {
  for (const value of iterable) {
    yield* yieldValue(value)
  }
}
