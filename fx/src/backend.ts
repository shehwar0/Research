// ============================================================================
// fx-ts — WasmFX Backend Abstraction
// ============================================================================
// Defines the backend abstraction layer that enables transparent swapping
// between different continuation/effect runtimes.
//
// Theoretical basis:
//   - Phipps-Costin et al. (OOPSLA 2023): "Continuing WebAssembly with
//     Effect Handlers" — WasmFX instruction set: cont.new, resume, suspend
//
// Architecture:
//   The Backend interface abstracts over 4 possible implementations:
//     1. Generator-based (Tier 1, pure JS — current default)
//     2. Koka CPS (Tier 2 — evidence-passing)
//     3. OCaml Wasm (Tier 3 — native effects via wasm_of_ocaml)
//     4. WasmFX (Tier 4 — native stack switching when available)
//
//   User code calls the same API regardless of backend. The runtime
//   auto-detects the best available backend or allows manual selection.
// ============================================================================

import type { Eff, EffectSignal, EffectReturn, Handler } from './types.js'

// ============================================================================
// Backend Interface
// ============================================================================

/**
 * A backend provides the core continuation mechanics.
 * Each backend implements perform/handle/run differently,
 * but exposes the same interface to user code.
 */
export interface Backend {
  /** Unique identifier for this backend */
  readonly name: string
  /** Human-readable description */
  readonly description: string
  /** Priority for auto-detection (higher = preferred) */
  readonly priority: number
  /** Check if this backend is available in the current environment */
  isAvailable(): boolean

  /**
   * Run a computation with a handler using this backend's mechanics.
   */
  runWithHandler<T, E extends EffectSignal>(
    handler: Handler<E>,
    computation: () => Eff<T, E>,
  ): T

  /**
   * Run a computation with async handler support.
   */
  runWithHandlerAsync<T, E extends EffectSignal>(
    handler: Handler<E>,
    computation: () => Eff<T, E>,
  ): Promise<T>

  /**
   * Run a pure computation (no effects).
   */
  runPure<T>(computation: () => Eff<T, never>): T
}

// ============================================================================
// Generator Backend (Tier 1)
// ============================================================================

/**
 * The default generator-based backend.
 * Uses JavaScript generators as asymmetric coroutines.
 * Works everywhere — browser, Node, Deno, Bun, Cloudflare Workers.
 */
export class GeneratorBackend implements Backend {
  readonly name = 'generator'
  readonly description = 'Generator-based one-shot continuations (pure JS)'
  readonly priority = 0

  isAvailable(): boolean {
    return true // Generators are available in all modern JS environments
  }

  runWithHandler<T, E extends EffectSignal>(
    handler: Handler<E>,
    computation: () => Eff<T, E>,
  ): T {
    const gen = computation()
    let input: any = undefined

    while (true) {
      const step = gen.next(input)
      if (step.done) return step.value

      const effect = step.value as EffectSignal

      if (handler.handles(effect)) {
        let resumeValue: any
        let didResume = false

        handler.handle(effect as E, (value: EffectReturn<E>) => {
          if (didResume) {
            throw new Error('fx: Cannot resume a one-shot continuation more than once.')
          }
          didResume = true
          resumeValue = value
        })

        if (!didResume) {
          throw new Error(
            `fx: Handler for "${effect._tag}" did not call resume() synchronously.`,
          )
        }
        input = resumeValue
      } else {
        throw new Error(`fx: Unhandled effect "${effect._tag}".`)
      }
    }
  }

  runWithHandlerAsync<T, E extends EffectSignal>(
    handler: Handler<E>,
    computation: () => Eff<T, E>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const gen = computation()

      const drive = (input: any): void => {
        try {
          const step = gen.next(input)
          if (step.done) { resolve(step.value); return }

          const effect = step.value as EffectSignal
          if (handler.handles(effect)) {
            let didResume = false
            handler.handle(effect as E, (value: EffectReturn<E>) => {
              if (didResume) {
                reject(new Error('fx: Cannot resume one-shot continuation twice.'))
                return
              }
              didResume = true
              drive(value)
            })
          } else {
            reject(new Error(`fx: Unhandled effect "${effect._tag}".`))
          }
        } catch (error) {
          reject(error)
        }
      }

      drive(undefined)
    })
  }

  runPure<T>(computation: () => Eff<T, never>): T {
    const gen = computation()
    const step = gen.next()
    if (!step.done) {
      throw new Error('fx: Pure computation yielded an effect.')
    }
    return step.value
  }
}

// ============================================================================
// WasmFX Backend Stub (Tier 4)
// ============================================================================

/**
 * WasmFX backend — uses WebAssembly stack switching for native
 * delimited continuations.
 *
 * This is a stub/shim implementation. When WasmFX lands in browsers,
 * this backend will use the native `cont.new`, `resume`, and `suspend`
 * instructions for true zero-overhead algebraic effects.
 *
 * Current status: WasmFX is in Phase 3 of the WebAssembly spec process.
 * V8 has a prototype behind --experimental-wasm-stack-switching flag.
 */
export class WasmFXBackend implements Backend {
  readonly name = 'wasmfx'
  readonly description = 'WasmFX native stack switching (when available)'
  readonly priority = 100 // Highest priority when available

  isAvailable(): boolean {
    // Check for WebAssembly stack switching support
    // This will return true when browsers implement WasmFX
    return typeof WebAssembly !== 'undefined' && this._hasStackSwitching()
  }

  private _hasStackSwitching(): boolean {
    try {
      // Probe for WasmFX support by checking for cont instructions
      // This is a feature-detection heuristic that will work when
      // WasmFX ships in browsers.
      //
      // Current browsers: NOT available
      // V8 prototype: available behind --experimental-wasm-stack-switching
      return false // Will be updated when WasmFX ships
    } catch {
      return false
    }
  }

  runWithHandler<T, E extends EffectSignal>(
    handler: Handler<E>,
    computation: () => Eff<T, E>,
  ): T {
    // Fall back to generator backend when WasmFX is not available
    // When WasmFX is available, this will use:
    //   const cont = cont_new(computation)
    //   const result = resume(cont, handler)
    throw new Error(
      'fx: WasmFX backend is not yet available. ' +
      'Use the generator backend or wait for WasmFX support in your environment.',
    )
  }

  runWithHandlerAsync<T, E extends EffectSignal>(
    handler: Handler<E>,
    computation: () => Eff<T, E>,
  ): Promise<T> {
    throw new Error('fx: WasmFX backend is not yet available.')
  }

  runPure<T>(computation: () => Eff<T, never>): T {
    throw new Error('fx: WasmFX backend is not yet available.')
  }
}

// ============================================================================
// Backend Registry — Auto-Detection & Selection
// ============================================================================

/**
 * Registry of available backends. Manages auto-detection and selection.
 */
export class BackendRegistry {
  private _backends: Backend[] = []
  private _selected: Backend | null = null

  constructor() {
    // Register default backends
    this.register(new GeneratorBackend())
    this.register(new WasmFXBackend())
  }

  /**
   * Register a new backend.
   */
  register(backend: Backend): void {
    this._backends.push(backend)
    this._backends.sort((a, b) => b.priority - a.priority)
    this._selected = null // Reset selection
  }

  /**
   * Get the best available backend.
   * Auto-detects based on priority and availability.
   */
  getBest(): Backend {
    if (this._selected) return this._selected

    for (const backend of this._backends) {
      if (backend.isAvailable()) {
        this._selected = backend
        return backend
      }
    }

    throw new Error('fx: No backend available. This should not happen.')
  }

  /**
   * Select a specific backend by name.
   */
  select(name: string): Backend {
    const backend = this._backends.find((b) => b.name === name)
    if (!backend) {
      throw new Error(
        `fx: Backend "${name}" not found. Available: ${this._backends.map((b) => b.name).join(', ')}`,
      )
    }
    if (!backend.isAvailable()) {
      throw new Error(`fx: Backend "${name}" is not available in this environment.`)
    }
    this._selected = backend
    return backend
  }

  /**
   * List all registered backends with their availability.
   */
  list(): { name: string; description: string; available: boolean; priority: number }[] {
    return this._backends.map((b) => ({
      name: b.name,
      description: b.description,
      available: b.isAvailable(),
      priority: b.priority,
    }))
  }

  /**
   * Get the currently selected backend name.
   */
  get current(): string {
    return this.getBest().name
  }
}

// ============================================================================
// Global Backend Instance
// ============================================================================

/** Global backend registry */
export const backends = new BackendRegistry()

/**
 * Get the current backend.
 */
export function getBackend(): Backend {
  return backends.getBest()
}

/**
 * Select a specific backend by name.
 */
export function selectBackend(name: string): Backend {
  return backends.select(name)
}
