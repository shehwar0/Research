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
//   ✓ Resource management (scoped acquire/release lifecycle)
//   ✓ Task groups with supervision strategies
//   ✓ Evidence-passing O(1) handler dispatch (Koka-inspired)
//   ✓ Multi-shot continuations (replay-based cloning)
//   ✓ Async effects (signal/execute/interrupt model)
//   ✓ Bidirectional effects (effect streams)
//   ✓ Lexical handler optimization (zero-overhead hot paths)
//   ✓ Backend abstraction (WasmFX-ready, transparent swap)
//   ✓ DevTools (effect inspector, profiler, visualizer)
//   ✓ Enterprise observability (OpenTelemetry-compatible)
//   ✓ Comprehensive benchmark suite
//
// Theoretical foundations:
//   - Plotkin & Pretnar (2009/2013) — Handling Algebraic Effects
//   - Kawahara & Kameyama (TFP 2020) — One-shot effects ≡ coroutines
//   - Leijen (POPL 2017) — Row-typed algebraic effects
//   - Leijen (MSR-TR-2016-29) — Evidence-passing compilation
//   - Brachthäuser (OOPSLA 2018) — Effect Handlers for the Masses
//   - Ahman & Pretnar (LMCS 2024) — Asynchronous Effects
//   - Zhang et al. (OOPSLA 2020) — Bidirectional Control Flow
//   - Ma & Zhang (OOPSLA 2025) — Zero-overhead lexical handlers
//   - Cong & Asai (APLAS 2023) — Multi-shot continuations
//   - Sivaramakrishnan (PLDI 2021) — Retrofitting effects to OCaml
//   - Phipps-Costin et al. (OOPSLA 2023) — Continuing WebAssembly with
//     Effect Handlers (WasmFX)
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

// ============================================================================
// Phase 2 — Structured Concurrency & Advanced Handlers
// ============================================================================

// === Resource Management ===
export type {
  Resource,
  ResourceDescriptor,
  AcquireEffect,
  ReleaseEffect,
} from './resource.js'
export {
  using,
  releaseEarly,
  bracket,
  bracketAsync,
  ResourceScope,
  AggregateResourceError,
  resourceHandler,
  usingDisposable,
  disposable,
} from './resource.js'

// === Task Groups ===
export type {
  SupervisionStrategy,
  TaskResult,
  GroupTask,
  TaskGroup,
} from './taskgroup.js'
export {
  createTaskGroup,
  withTaskGroup,
  parallel,
  parallelN,
} from './taskgroup.js'

// === Evidence-Passing Handler Dispatch ===
export type {
  EvidenceEntry,
  EvidenceMarker,
} from './evidence.js'
export {
  EvidenceVector,
  createMarker,
  getCurrentEvidence,
  withEvidence,
  handleAsyncWithEvidence,
  performE,
  runWithEvidence,
} from './evidence.js'

// === Type Inference Helpers ===
export type {
  InferEffects,
  InferReturn,
  RequiresHandling,
  AssertPure,
  HandlerFor,
  RemainingEffects,
  MergeEffects,
  ContainsEffect,
  ExtractEffect,
  EffectTagsOf,
  WithHandled,
  PipeHandled,
  EffectsOf,
  ReturnOf,
  HandlerCovers,
  ComposedHandler,
} from './infer.js'

// ============================================================================
// Phase 3 — Advanced Features
// ============================================================================

// === Multi-Shot Continuations ===
export type {
  InputLog,
  MultiShotContinuation,
  MultiShotResult,
  MultiShotHandler,
  ChooseEffect,
  AmbEffect,
} from './multishot.js'
export {
  captureMultiShot,
  handleMultiShot,
  createMultiShotHandler,
  choose,
  allChoicesHandler,
  collectAll,
  amb,
  ambHandler,
} from './multishot.js'

// === Async Effects (Ahman & Pretnar) ===
export type {
  SignalAsyncEffect,
  AwaitHandleEffect,
  AsyncOperation,
} from './async-effects.js'
export {
  AsyncHandle,
  signalAsync,
  awaitHandle,
  asyncEffectHandler,
  runAsyncEffects,
  pipeline,
} from './async-effects.js'

// === Bidirectional Effects (Zhang 2020) ===
export type {
  YieldEffect,
  EffectStream,
} from './bidirectional.js'
export {
  yieldValue,
  yieldAll,
  collectStream,
  forEachEffect,
  mapStream,
  filterStream,
  takeStream,
  chainStream,
  toAsyncIterable,
  fromIterable,
} from './bidirectional.js'

// === Lexical Effect Handler Optimization (Ma & Zhang 2025) ===
export type {
  LexicalHandlerDef,
  LexicalHandler,
} from './lexical.js'
export {
  createLexicalHandler,
  handleLexical,
  runLexical,
  isTailResumptive,
  toLexicalHandler,
  benchmarkHandler,
} from './lexical.js'

// ============================================================================
// Phase 4 — WasmFX & Production Hardening
// ============================================================================

// === Backend Abstraction (WasmFX-Ready) ===
export type {
  Backend,
} from './backend.js'
export {
  GeneratorBackend,
  WasmFXBackend,
  BackendRegistry,
  backends,
  getBackend,
  selectBackend,
} from './backend.js'

// === DevTools: Inspector, Profiler & Visualizer ===
export type {
  EffectEvent,
  TraceSummary,
  EffectStat,
  PerformanceProfile,
  EffectProfile,
  HandlerStackSnapshot,
  MonitoringStats,
  EffectMonitorStat,
} from './devtools.js'
export {
  EffectTrace,
  inspect,
  profileComputation,
  HandlerStackTracker,
  visualizeTrace,
  EffectMonitor,
} from './devtools.js'

// === Enterprise Observability (OpenTelemetry) ===
export type {
  TraceId,
  SpanId,
  SpanStatus,
  SpanAttributes,
  SpanEvent,
  EffectSpan,
  SpanExporter,
} from './observability.js'
export {
  generateTraceId,
  generateSpanId,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  EffectTracer,
  EffectMetrics,
  instrumentHandler,
} from './observability.js'

// === Benchmark Suite ===
export type {
  BenchmarkResult,
  BenchmarkSuite,
} from './benchmark.js'
export {
  benchmark,
  benchmarkAsync,
  runCoreBenchmarks,
  formatBenchmarkResults,
  formatBenchmarkMarkdown,
  compareBenchmarks,
} from './benchmark.js'
