// ============================================================================
// fx-ts — True Algebraic Effects for JavaScript & TypeScript
// ============================================================================
//
// A production-grade algebraic effects library providing:
//   ✓ Resumable delimited continuations via generators
//   ✓ Typed effect rows (compile-time tracked effects)
//   ✓ Structured concurrency (parent-child scope lifetimes)
//   ✓ Typed error channels (replacing untyped throw/catch)
//   ✓ Promise/async interop (bridging effects and promises)
//   ✓ AI agent effects (LLM, tools, memory, observability)
//   ✓ Zero-overhead testing (swap handler, zero code changes)
//
// Theoretical foundations:
//   - Plotkin & Pretnar (2009/2013) — Handling Algebraic Effects
//   - Kawahara & Kameyama (TFP 2020) — One-shot effects ≡ coroutines
//   - Leijen (POPL 2017) — Row-typed algebraic effects
//   - Brachthäuser (OOPSLA 2018) — Effect Handlers for the Masses
//   - Ma & Zhang (OOPSLA 2025) — Zero-overhead lexical handlers
//
// ============================================================================

// === Core Types ===
export type {
  // Effect system types
  EffectSignal,
  Effect,
  EffectReturn,
  Eff,
  Pure,
  EffFn,
  Handled,
  EffectTags,
  // Handler types
  ResumeFn,
  EffectHandler,
  HandlerDef,
  Handler,
  // Concurrency types
  TaskId,
  TaskStatus,
  Task,
  Scope,
  // Built-in effects
  SpawnEffect,
  CancelEffect,
  ScopeEffect,
  SleepEffect,
  ErrorEffect,
  // Result type
  Result,
} from './types.js'

export { Ok, Err } from './types.js'

// === Core Primitives ===
export {
  perform,
  createHandler,
  handle,
  handleAsync,
  withHandler,
  run,
  runAsync,
  compose,
  composeAll,
} from './core.js'

// === Structured Concurrency ===
export {
  spawn,
  cancel,
  useScope,
  sleep,
  all,
  race,
  createScope,
  ScopeImpl,
  CancellationError,
  scopeHandler,
} from './concurrency.js'

// === Error Handling ===
export type { FailEffect } from './errors.js'
export {
  fail,
  catchFail,
  recover,
  recoverWith,
  mapError,
  ensure,
  retry,
} from './errors.js'

// === Interop ===
export type {
  AsyncEffect,
  CallbackEffect,
  AbortSignalEffect,
} from './interop.js'
export {
  fromPromise,
  fromPromiseValue,
  toPromise,
  fromCallback,
  useAbortSignal,
  asyncHandler,
  callbackHandler,
} from './interop.js'

// === AI Agent Effects ===
export {
  Model,
  type GenerateEffect,
  type GenerateOptions,
  type ToolEffect,
  type RememberEffect,
  type RecallEffect,
  type ObserveEffect,
  type AgentEffects,
  generate,
  useTool,
  remember,
  recall,
  observe,
  mockGenerateHandler,
  mockToolHandler,
  inMemoryHandler,
  consoleObserveHandler,
} from './ai.js'
