/**
 * Lightweight in-process event bus.
 *
 * Decouples producers (the signal monitor, the live data manager) from
 * consumers (the Discord notifier, the dashboard SSE endpoint) so neither
 * side needs a direct reference to the other.
 */
import { EventEmitter } from "events";
import type { Tick } from "../data/types.js";
import type { GradedSignal } from "../signals/scorer.js";

export interface BusEvents {
  tick: (tick: Tick) => void;
  signal: (signal: GradedSignal) => void;
}

class TypedBus extends EventEmitter {
  emitTick(tick: Tick): void {
    this.emit("tick", tick);
  }

  emitSignal(signal: GradedSignal): void {
    this.emit("signal", signal);
  }

  onTick(handler: BusEvents["tick"]): () => void {
    this.on("tick", handler);
    return () => this.off("tick", handler);
  }

  onSignal(handler: BusEvents["signal"]): () => void {
    this.on("signal", handler);
    return () => this.off("signal", handler);
  }
}

/** Shared singleton bus. */
export const bus = new TypedBus();

// The dashboard may attach one listener per SSE client; lift the default cap.
bus.setMaxListeners(100);
