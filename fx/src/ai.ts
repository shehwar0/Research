// ============================================================================
// fx-ts — AI Agent Effect Types
// ============================================================================
// First-class algebraic effects for AI agent orchestration.
//
// Algebraic effects are the natural primitive for AI agents because:
//   1. LLM calls are effects — the business logic just "performs Generate"
//   2. Tool use is an effect — handlers decide which tools and how
//   3. Memory is an effect — handlers choose storage strategy
//   4. Testing is trivial — swap handler for mock LLM, zero code changes
//   5. Retry/backoff is a handler concern, not business logic
//   6. Observability is handler composition — logging wraps any handler
// ============================================================================

import type { Eff, Effect, EffectSignal } from './types.js'
import { perform } from './core.js'

// ============================================================================
// AI Effect Definitions
// ============================================================================

/** Model selection for LLM generation */
export enum Model {
  Fast = 'fast',
  Smart = 'smart',
  Code = 'code',
  Embedding = 'embedding',
}

/** LLM text generation effect */
export interface GenerateEffect
  extends Effect<'Generate', { prompt: string; model: Model; options?: GenerateOptions }, string> {
  readonly prompt: string
  readonly model: Model
  readonly options?: GenerateOptions
}

export interface GenerateOptions {
  readonly temperature?: number
  readonly maxTokens?: number
  readonly systemPrompt?: string
  readonly stop?: string[]
}

/** Tool invocation effect */
export interface ToolEffect<T = unknown>
  extends Effect<'UseTool', { name: string; args: unknown }, T> {
  readonly name: string
  readonly args: unknown
}

/** Memory storage effect */
export interface RememberEffect
  extends Effect<'Remember', { key: string; value: unknown }, void> {
  readonly key: string
  readonly value: unknown
}

/** Memory retrieval effect */
export interface RecallEffect<T = unknown>
  extends Effect<'Recall', { key: string }, T | undefined> {
  readonly key: string
}

/** Observability / tracing effect */
export interface ObserveEffect
  extends Effect<'Observe', { event: string; data?: unknown }, void> {
  readonly event: string
  readonly data?: unknown
}

/** All AI agent effects combined */
export type AgentEffects =
  | GenerateEffect
  | ToolEffect
  | RememberEffect
  | RecallEffect
  | ObserveEffect

// ============================================================================
// AI Effect Performers
// ============================================================================

/**
 * Generate text using an LLM.
 *
 * @example
 * ```typescript
 * function* summarize(text: string): Eff<string, GenerateEffect> {
 *   return yield* generate(`Summarize: ${text}`, Model.Smart)
 * }
 * ```
 */
export function* generate(
  prompt: string,
  model: Model = Model.Smart,
  options?: GenerateOptions,
): Eff<string, GenerateEffect> {
  return yield* perform<GenerateEffect>({
    _tag: 'Generate',
    prompt,
    model,
    options,
  } as GenerateEffect)
}

/**
 * Use a tool within an agent workflow.
 *
 * @example
 * ```typescript
 * function* search(query: string): Eff<SearchResult[], ToolEffect<SearchResult[]>> {
 *   return yield* useTool<SearchResult[]>('web_search', { query })
 * }
 * ```
 */
export function* useTool<T = unknown>(
  name: string,
  args: unknown,
): Eff<T, ToolEffect<T>> {
  return yield* perform<ToolEffect<T>>({
    _tag: 'UseTool',
    name,
    args,
  } as ToolEffect<T>)
}

/**
 * Store a value in agent memory.
 */
export function* remember(
  key: string,
  value: unknown,
): Eff<void, RememberEffect> {
  return yield* perform<RememberEffect>({
    _tag: 'Remember',
    key,
    value,
  } as RememberEffect)
}

/**
 * Recall a value from agent memory.
 */
export function* recall<T = unknown>(
  key: string,
): Eff<T | undefined, RecallEffect<T>> {
  return yield* perform<RecallEffect<T>>({
    _tag: 'Recall',
    key,
  } as RecallEffect<T>)
}

/**
 * Emit an observability event.
 */
export function* observe(
  event: string,
  data?: unknown,
): Eff<void, ObserveEffect> {
  return yield* perform<ObserveEffect>({
    _tag: 'Observe',
    event,
    data,
  } as ObserveEffect)
}

// ============================================================================
// Mock Handlers for Testing
// ============================================================================

import { createHandler } from './core.js'

/**
 * Create a mock LLM handler for testing.
 *
 * @example
 * ```typescript
 * const mock = mockGenerateHandler((prompt) => `Mock response for: ${prompt}`)
 *
 * // ZERO changes to business logic:
 * const summary = run(() => handle(mock, () => summarize('hello')))
 * ```
 */
export function mockGenerateHandler(
  responder: (prompt: string, model: Model) => string,
) {
  return createHandler<GenerateEffect>({
    Generate: (effect, resume) => {
      resume(responder(effect.prompt, effect.model))
    },
  })
}

/**
 * Create a mock tool handler for testing.
 */
export function mockToolHandler(
  responder: (name: string, args: unknown) => unknown,
) {
  return createHandler<ToolEffect>({
    UseTool: (effect, resume) => {
      resume(responder(effect.name, effect.args) as any)
    },
  })
}

/**
 * Create an in-memory handler for agent memory effects.
 */
export function inMemoryHandler() {
  const store = new Map<string, unknown>()

  return createHandler<RememberEffect | RecallEffect>({
    Remember: (effect: RememberEffect, resume: (v: any) => void) => {
      store.set(effect.key, effect.value)
      resume(undefined)
    },
    Recall: (effect: RecallEffect, resume: (v: any) => void) => {
      resume(store.get(effect.key))
    },
  } as any)
}

/**
 * Create a logging handler for observability effects.
 */
export function consoleObserveHandler() {
  return createHandler<ObserveEffect>({
    Observe: (effect, resume) => {
      console.log(`[fx:observe] ${effect.event}`, effect.data ?? '')
      resume(undefined as any)
    },
  })
}
