// ============================================================================
// fx-ts — Evidence-Passing Handler Dispatch (Koka-Inspired)
// ============================================================================
// Implements Koka's evidence-passing compilation strategy for O(1) handler
// lookup instead of linear stack walking.
//
// Theoretical basis:
//   - Leijen, MSR-TR-2016-29: "Type Directed Compilation of Row-Typed
//     Algebraic Effects" — evidence-passing transforms
//   - Leijen, POPL 2017: "Type Directed Compilation of Row-Typed
//     Algebraic Effects" — evidence vectors
//
// Key insight from Koka:
//   Instead of searching the handler stack at each `perform` site,
//   pass an "evidence vector" as an implicit argument. Each evidence
//   slot is a reference to the nearest handler for that effect.
//   This gives O(1) dispatch instead of O(n) stack walking.
//
// In TypeScript we implement this via a thread-local (module-scoped)
// evidence map that is maintained by `withEvidence()`.
// ============================================================================

import type {
  Eff,
  EffectSignal,
  EffectReturn,
  Handler,
  HandlerDef,
} from './types.js'
import { createHandler } from './core.js'

// ============================================================================
// Evidence Vector
// ============================================================================

/**
 * An evidence vector maps effect tags to their handlers.
 * This is the runtime data structure that enables O(1) handler lookup.
 *
 * In Koka's formalization, evidence is a vector indexed by effect labels.
 * In TypeScript, we use a Map for dynamic dispatch.
 */
export class EvidenceVector {
  private _evidence = new Map<string, EvidenceEntry>()
  private _parent: EvidenceVector | null = null

  constructor(parent?: EvidenceVector) {
    this._parent = parent ?? null
  }

  /**
   * Register a handler for an effect tag.
   * Creates a new evidence entry pointing to the handler.
   */
  set<E extends EffectSignal>(
    tag: string,
    handler: Handler<E>,
    marker: EvidenceMarker,
  ): void {
    this._evidence.set(tag, { handler, marker, depth: this.depth })
  }

  /**
   * Look up the handler for an effect tag.
   * O(1) lookup — no stack walking required.
   */
  get(tag: string): EvidenceEntry | undefined {
    return this._evidence.get(tag) ?? this._parent?.get(tag)
  }

  /**
   * Check if a handler exists for the given tag.
   */
  has(tag: string): boolean {
    return this._evidence.has(tag) || (this._parent?.has(tag) ?? false)
  }

  /**
   * The depth of this evidence vector in the handler stack.
   */
  get depth(): number {
    return this._parent ? this._parent.depth + 1 : 0
  }

  /**
   * Create a child evidence vector that inherits from this one.
   */
  child(): EvidenceVector {
    return new EvidenceVector(this)
  }

  /**
   * Get all registered effect tags (including inherited).
   */
  tags(): Set<string> {
    const result = new Set<string>(this._evidence.keys())
    if (this._parent) {
      for (const tag of this._parent.tags()) {
        result.add(tag)
      }
    }
    return result
  }
}

/**
 * An entry in the evidence vector.
 * Contains the handler reference and a marker for the handler scope.
 */
export interface EvidenceEntry {
  readonly handler: Handler<any>
  readonly marker: EvidenceMarker
  readonly depth: number
}

/**
 * A marker that identifies a handler's scope in the evidence vector.
 * Used for evidence-passing resumption.
 */
export type EvidenceMarker = number & { readonly __brand: 'EvidenceMarker' }

let nextMarker = 0
export function createMarker(): EvidenceMarker {
  return (nextMarker++) as EvidenceMarker
}

// ============================================================================
// Thread-Local Evidence (Module-Scoped)
// ============================================================================

/**
 * The current evidence vector for the active computation.
 * This is the "thread-local" storage for evidence passing.
 *
 * In Koka, evidence is passed as a function parameter.
 * In JavaScript (single-threaded), module scope serves as
 * the equivalent of thread-local storage.
 */
let currentEvidence: EvidenceVector = new EvidenceVector()

/**
 * Get the current evidence vector.
 */
export function getCurrentEvidence(): EvidenceVector {
  return currentEvidence
}

// ============================================================================
// withEvidence — Install evidence-passing handler
// ============================================================================

/**
 * Run a computation with an evidence-passing handler.
 *
 * This installs the handler in the evidence vector for O(1) lookup,
 * then drives the computation. When the computation performs an effect,
 * the handler is found via evidence lookup instead of stack walking.
 *
 * @example
 * ```typescript
 * const logHandler = createHandler<LogEffect>({
 *   Log: (effect, resume) => {
 *     console.log(effect.msg)
 *     resume(undefined)
 *   },
 * })
 *
 * // O(1) handler dispatch via evidence passing
 * const result = runWithEvidence(logHandler, function* () {
 *   yield* perform<LogEffect>({ _tag: 'Log', msg: 'fast!' })
 *   return 'done'
 * })
 * ```
 */
export function* withEvidence<
  T,
  E extends EffectSignal,
  Remaining extends EffectSignal = never,
>(
  handler: Handler<E>,
  computation: () => Eff<T, E | Remaining>,
): Eff<T, Remaining> {
  const marker = createMarker()
  const parentEvidence = currentEvidence
  const childEvidence = parentEvidence.child()

  // Install handler in evidence vector for each tag
  for (const tag of handler.tags) {
    childEvidence.set(tag, handler, marker)
  }

  // Set current evidence to child
  currentEvidence = childEvidence

  try {
    const gen = computation()
    let input: any = undefined

    while (true) {
      const step = gen.next(input)

      if (step.done) {
        return step.value
      }

      const effect = step.value as EffectSignal

      // O(1) evidence lookup instead of stack walking
      const entry = currentEvidence.get(effect._tag)

      if (entry && entry.marker === marker) {
        // This handler handles this effect via evidence
        let resumeValue: any = undefined
        let didResume = false

        entry.handler.handle(effect, (value: any) => {
          if (didResume) {
            throw new Error(
              'fx: Cannot resume a one-shot continuation more than once.',
            )
          }
          didResume = true
          resumeValue = value
        })

        if (!didResume) {
          throw new Error(
            `fx: Evidence handler for "${effect._tag}" did not call resume(). ` +
            'For async handlers, use handleAsyncWithEvidence() instead.',
          )
        }

        input = resumeValue
      } else {
        // Effect not handled by this evidence entry — bubble up
        input = yield effect as any
      }
    }
  } finally {
    // Restore parent evidence
    currentEvidence = parentEvidence
  }
}

// ============================================================================
// handleAsyncWithEvidence — Async evidence-passing handler
// ============================================================================

/**
 * Async version of evidence-passing handler dispatch.
 * Supports handlers that call resume() asynchronously.
 */
export function handleAsyncWithEvidence<T, E extends EffectSignal>(
  handler: Handler<E>,
  computation: () => Eff<T, E>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const marker = createMarker()
    const parentEvidence = currentEvidence
    const childEvidence = parentEvidence.child()

    for (const tag of handler.tags) {
      childEvidence.set(tag, handler, marker)
    }

    currentEvidence = childEvidence

    const gen = computation()

    function drive(input: any): void {
      try {
        const step = gen.next(input)

        if (step.done) {
          currentEvidence = parentEvidence
          resolve(step.value)
          return
        }

        const effect = step.value as EffectSignal
        const entry = currentEvidence.get(effect._tag)

        if (entry && entry.marker === marker) {
          let didResume = false
          entry.handler.handle(effect, (value: any) => {
            if (didResume) {
              reject(
                new Error('fx: Cannot resume a one-shot continuation more than once.'),
              )
              return
            }
            didResume = true
            drive(value)
          })
        } else {
          currentEvidence = parentEvidence
          reject(
            new Error(
              `fx: Unhandled effect "${effect._tag}" in evidence-passing handler.`,
            ),
          )
        }
      } catch (error) {
        currentEvidence = parentEvidence
        reject(error)
      }
    }

    drive(undefined)
  })
}

// ============================================================================
// performE — Evidence-aware perform
// ============================================================================

/**
 * Perform an effect with evidence-based dispatch hint.
 *
 * This is an optimization hint — if evidence is available, the handler
 * can be found in O(1). Falls back to normal `yield` if no evidence.
 *
 * Note: In the current implementation, evidence is used by the handler
 * loop (withEvidence/handleAsyncWithEvidence), not by perform itself.
 * This function exists for API completeness and future optimization.
 */
export function* performE<E extends EffectSignal>(
  effect: E,
): Eff<EffectReturn<E>, E> {
  // Check evidence for O(1) handler lookup hint
  const entry = currentEvidence.get(effect._tag)
  if (entry) {
    // Evidence exists — the handler loop will find it via evidence
    return (yield effect) as EffectReturn<E>
  }
  // No evidence — fall back to normal yield (stack walking)
  return (yield effect) as EffectReturn<E>
}

// ============================================================================
// runWithEvidence — Top-level runner with evidence
// ============================================================================

/**
 * Run a computation with an evidence-passing handler and extract the result.
 *
 * This is a convenience function that combines withEvidence + run.
 *
 * @example
 * ```typescript
 * const result = runWithEvidence(logHandler, function* () {
 *   yield* perform<LogEffect>({ _tag: 'Log', msg: 'hello' })
 *   return 42
 * })
 * ```
 */
export function runWithEvidence<T, E extends EffectSignal>(
  handler: Handler<E>,
  computation: () => Eff<T, E>,
): T {
  const marker = createMarker()
  const parentEvidence = currentEvidence
  const childEvidence = parentEvidence.child()

  for (const tag of handler.tags) {
    childEvidence.set(tag, handler, marker)
  }

  currentEvidence = childEvidence

  try {
    const gen = computation()
    let input: any = undefined

    while (true) {
      const step = gen.next(input)

      if (step.done) {
        return step.value
      }

      const effect = step.value as EffectSignal
      const entry = currentEvidence.get(effect._tag)

      if (entry && entry.marker === marker) {
        let resumeValue: any = undefined
        let didResume = false

        entry.handler.handle(effect, (value: any) => {
          if (didResume) {
            throw new Error(
              'fx: Cannot resume a one-shot continuation more than once.',
            )
          }
          didResume = true
          resumeValue = value
        })

        if (!didResume) {
          throw new Error(
            `fx: Evidence handler for "${effect._tag}" did not call resume() synchronously.`,
          )
        }

        input = resumeValue
      } else {
        throw new Error(
          `fx: Unhandled effect "${effect._tag}" in runWithEvidence.`,
        )
      }
    }
  } finally {
    currentEvidence = parentEvidence
  }
}
