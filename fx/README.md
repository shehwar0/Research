# fx-ts

**True algebraic effects for JavaScript & TypeScript** — resumable continuations, typed effect rows, structured concurrency, and zero-overhead testing.

> *"What if every async operation, every side effect, every IO call was just a signal — and you could intercept all of them?"*

## Why fx-ts?

JavaScript's async model is fundamentally broken:

| Problem | JS Today | fx-ts |
|---------|----------|-------|
| **No true cancellation** | `AbortController` is manual, non-composable | Cancellation is an algebraic effect — automatic propagation |
| **No structured concurrency** | Promise.all() can leak "ghost tasks" | Parent scopes guarantee child lifetimes |
| **Error chaos** | try/catch, .catch(), 'error' events — 3 incompatible systems | Typed error effects with compile-time tracking |
| **No resumable control flow** | Async functions can't pause and be resumed by someone else | Generator-based delimited continuations |
| **Function coloring** | `async` poisons every caller | Effects are transparent — handlers decide sync vs async |
| **Testing is painful** | Mock fetch, rewire modules, dependency injection | Swap handler, zero code changes |

## Installation

```bash
npm install fx-ts
```

## Quick Start

```typescript
import { perform, createHandler, handle, run, type Eff, type Effect } from 'fx-ts'

// 1. Define an effect
interface FetchEffect extends Effect<'Fetch', { url: string }, any> {
  readonly url: string
}

// 2. Write business logic using effects
function* getUser(id: number): Eff<User, FetchEffect> {
  const data = yield* perform<FetchEffect>({ _tag: 'Fetch', url: `/api/users/${id}` })
  return data as User
}

// 3. Handle the effect — production
const realFetch = createHandler<FetchEffect>({
  Fetch: (effect, resume) => {
    fetch(effect.url).then(r => r.json()).then(data => resume(data))
  }
})

// 4. Handle the effect — testing (ZERO changes to business logic!)
const mockFetch = createHandler<FetchEffect>({
  Fetch: (effect, resume) => {
    resume({ id: 1, name: 'Test User' })
  }
})

// 5. Run with either handler
const user = run(() => handle(mockFetch, () => getUser(42)))
console.log(user) // { id: 1, name: 'Test User' }
```

## Core Concepts

### Effects are Signals, Not Actions

In fx-ts, when your code needs to do something (fetch data, log a message, read state), it doesn't *do* it. Instead, it **performs an effect** — which is just yielding a signal that says *"I need this done"*. A **handler** intercepts that signal and decides what actually happens.

```typescript
// This function doesn't fetch anything — it signals that it needs data
function* fetchUser(id: number): Eff<User, FetchEffect> {
  return yield* perform<FetchEffect>({ _tag: 'Fetch', url: `/api/users/${id}` })
}
```

### Handlers are Swappable

The same business logic runs with completely different implementations:

```typescript
// Production: real HTTP calls
const prodHandler = createHandler<FetchEffect>({
  Fetch: (effect, resume) => fetch(effect.url).then(r => r.json()).then(resume)
})

// Testing: instant mock responses
const testHandler = createHandler<FetchEffect>({
  Fetch: (effect, resume) => resume({ id: 1, name: 'Mock' })
})

// Caching: add caching without touching business logic
const cacheHandler = createHandler<FetchEffect>({
  Fetch: (effect, resume) => {
    const cached = cache.get(effect.url)
    if (cached) return resume(cached)
    fetch(effect.url).then(r => r.json()).then(data => {
      cache.set(effect.url, data)
      resume(data)
    })
  }
})
```

### Typed Effect Rows

TypeScript tracks exactly which effects a function may perform:

```typescript
// This function performs FetchEffect AND LogEffect
function* loadDashboard(): Eff<Dashboard, FetchEffect | LogEffect> {
  yield* perform<LogEffect>({ _tag: 'Log', msg: 'Loading...' })
  const user = yield* perform<FetchEffect>({ _tag: 'Fetch', url: '/api/me' })
  return { user }
}
```

### Handler Composition

Compose multiple handlers to handle different effects:

```typescript
import { compose, composeAll } from 'fx-ts'

const combined = compose(fetchHandler, logHandler)
// or
const allHandlers = composeAll(fetchHandler, logHandler, stateHandler)

const result = run(() => handle(combined, () => loadDashboard()))
```

## Error Handling

```typescript
import { fail, catchFail, recover, retry, type FailEffect } from 'fx-ts'

// Typed errors as effects
function* getUser(id: number): Eff<User, FailEffect<NotFoundError>> {
  if (id === 0) yield* fail<NotFoundError>({ _tag: 'NotFound', id })
  return { id, name: 'Alice' }
}

// Catch and convert to Result
const result = run(function* () {
  return yield* catchFail(() => getUser(0))
})
// result = { ok: false, error: { _tag: 'NotFound', id: 0 } }

// Recover with fallback
const user = run(function* () {
  return yield* recover(() => getUser(0), () => ({ id: 0, name: 'Guest' }))
})

// Retry with backoff
const data = run(function* () {
  return yield* retry(3, () => riskyOperation())
})
```

## Async Interop

```typescript
import { fromPromise, toPromise, handleAsync } from 'fx-ts'

// Promise → Effect
function* fetchData(): Eff<Data, AsyncEffect<Data>> {
  return yield* fromPromise(() => fetch('/api/data').then(r => r.json()))
}

// Effect → Promise
const data = await toPromise(fetchData)

// Async handlers
const result = await handleAsync(fetchHandler, function* () {
  return yield* getUser(42)
})
```

## AI Agent Effects

```typescript
import { generate, useTool, remember, recall, observe, Model,
         mockGenerateHandler, inMemoryHandler } from 'fx-ts'

// Business logic — pure, testable, no API keys in sight
function* researchAgent(query: string) {
  yield* observe('start', { query })
  const results = yield* useTool('search', { query })
  yield* remember('context', results)
  const summary = yield* generate(`Summarize: ${query}`, Model.Smart)
  yield* observe('done', { summary })
  return summary
}

// Test with mock handlers — ZERO changes needed
const mockLLM = mockGenerateHandler((prompt) => `Mock: ${prompt}`)
const memory = inMemoryHandler()
const result = run(() => handle(compose(mockLLM, memory), () => researchAgent('test')))
```

## API Reference

### Core
- `perform<E>(effect)` — Yield an effect signal to the nearest handler
- `createHandler<E>(def)` — Create a handler from tag→callback mapping
- `handle(handler, computation)` — Run computation with sync handler
- `handleAsync(handler, computation)` — Run computation with async handler
- `run(computation)` — Execute a fully-handled computation
- `compose(h1, h2)` — Compose two handlers
- `composeAll(...handlers)` — Compose multiple handlers

### Error Handling
- `fail<E>(error)` — Raise a typed error effect
- `catchFail(computation)` — Catch errors as Result<A, E>
- `recover(computation, onError)` — Recover with fallback value
- `recoverWith(computation, onError)` — Recover with effectful fallback
- `mapError(computation, f)` — Transform error types
- `retry(n, computation)` — Retry on failure
- `ensure(computation, cleanup)` — Finally/cleanup guarantee

### Concurrency
- `createScope(parent?)` — Create a structured scope
- `spawn(computation)` — Spawn child task in current scope
- `cancel(taskId)` — Cancel a running task
- `sleep(ms)` — Sleep effect
- `all(computations)` — Run all, cancel on first failure
- `race(computations)` — First to complete, cancel rest

### Interop
- `fromPromise(thunk)` — Lift Promise into effect
- `toPromise(computation)` — Convert effect to Promise
- `fromCallback(register)` — Lift callback API into effect

### AI
- `generate(prompt, model?, options?)` — LLM text generation
- `useTool(name, args)` — Tool invocation
- `remember(key, value)` — Memory store
- `recall(key)` — Memory recall
- `observe(event, data?)` — Observability
- `mockGenerateHandler(responder)` — Mock LLM for testing
- `mockToolHandler(responder)` — Mock tools for testing
- `inMemoryHandler()` — In-memory storage handler

## Theoretical Foundations

fx-ts is built on peer-reviewed research:

- **Plotkin & Pretnar (2013)** — *Handling Algebraic Effects* — core perform/handle semantics
- **Kawahara & Kameyama (2020)** — *One-shot Algebraic Effects as Coroutines* — proves generators ≡ one-shot effects  
- **Leijen (2017)** — *Type Directed Compilation of Row-Typed Effects* — effect row encoding
- **Brachthäuser et al. (2018)** — *Effect Handlers for the Masses* — capability-passing API design
- **Ma & Zhang (2025)** — *Zero-Overhead Lexical Effect Handlers* — performance optimization path

## License

MIT
