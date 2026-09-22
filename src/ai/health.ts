/**
 * AI provider health.
 *
 * Every model call reports success or failure here, and the operator hears
 * about it when a provider breaks — and again when it recovers.
 *
 * Retries already happen below this layer: both SDKs retry rate limits, 5xx,
 * timeouts, and dropped connections twice with backoff, and the council
 * retries a garbled reply once. So what reaches this module is what retrying
 * couldn't fix. Before it existed those failures only showed up in container
 * logs — an invalid Anthropic key once went unnoticed until a chat broke.
 *
 * Alert policy (per provider):
 * - Failures that need a human (bad key, no credits, retired model) alert on
 *   the first occurrence. Retrying won't help, so there's no reason to wait.
 * - Transient failures alert only after TRANSIENT_ALERT_AFTER in a row, so a
 *   one-off blip stays quiet.
 * - While still failing, a reminder goes out at most every REMINDER_INTERVAL_MS.
 * - The first success after an alert sends a recovery notice.
 */

export type FailureKind =
  | "auth"
  | "quota"
  | "model_unavailable"
  | "rate_limit"
  | "timeout"
  | "provider_down"
  | "bad_response"
  | "unknown";

/** Failures that retrying can't fix — they need someone to act. */
const NEEDS_ACTION: ReadonlySet<FailureKind> = new Set(["auth", "quota", "model_unavailable"]);

export const TRANSIENT_ALERT_AFTER = 3;
export const REMINDER_INTERVAL_MS = 6 * 3_600_000;

/** Env var holding each provider's key, for the "rotate X" advice. */
const KEY_ENV: Record<string, string> = {
  OpenAI: "OPENAI_API_KEY",
  Claude: "ANTHROPIC_API_KEY",
  Gemini: "GEMINI_API_KEY",
  Groq: "GROQ_API_KEY",
  Cohere: "COHERE_API_KEY",
  Mistral: "MISTRAL_API_KEY",
  DeepSeek: "DEEPSEEK_API_KEY",
};

/** A model replied, but not with anything usable. */
export class BadResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadResponseError";
  }
}

interface ErrorShape {
  status?: number;
  code?: string;
  type?: string;
  name?: string;
  message?: string;
  error?: { code?: string; type?: string; error?: { type?: string } };
}

/**
 * Classify a provider error. Reads the SDKs' structured fields (status, code)
 * first and falls back to message text, since the OpenAI-compatible endpoints
 * (Gemini, Groq, ...) don't all populate them the same way.
 */
export function classifyProviderError(err: unknown): FailureKind {
  const e = (err ?? {}) as ErrorShape;
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = (e.code ?? e.error?.code ?? e.error?.type ?? e.error?.error?.type ?? "").toLowerCase();
  const message = (e.message ?? String(err)).toLowerCase();
  const name = e.name ?? "";

  if (err instanceof BadResponseError) return "bad_response";

  // Before rate limits: OpenAI reports an empty balance as a 429.
  if (
    code === "insufficient_quota" ||
    /insufficient_quota|credit balance|exceeded your current quota|billing|payment required/.test(message) ||
    status === 402
  ) {
    return "quota";
  }

  if (
    status === 401 ||
    status === 403 ||
    code === "authentication_error" ||
    code === "invalid_api_key" ||
    /invalid api key|incorrect api key|invalid x-api-key|unauthorized|authentication/.test(message)
  ) {
    return "auth";
  }

  if (
    status === 404 ||
    code === "model_not_found" ||
    code === "not_found_error" ||
    /model.*(not found|does not exist|decommissioned|deprecated|no longer)/.test(message)
  ) {
    return "model_unavailable";
  }

  if (status === 429 || code === "rate_limit_error" || /rate limit|too many requests/.test(message)) {
    return "rate_limit";
  }

  if (/timeout/i.test(name) || /timed out|timeout|aborted/.test(message)) return "timeout";

  if (
    (status !== undefined && status >= 500) ||
    code === "overloaded_error" ||
    /overloaded|econnrefused|enotfound|econnreset|connection error|socket hang up/.test(message)
  ) {
    return "provider_down";
  }

  if (name === "ZodError" || err instanceof SyntaxError || /no json object|unexpected token|json/.test(message)) {
    return "bad_response";
  }

  return "unknown";
}

function adviceFor(provider: string, kind: FailureKind): string {
  const keyEnv = KEY_ENV[provider] ?? "its API key";
  switch (kind) {
    case "auth":
      return `The API key was rejected. Rotate ${keyEnv} in the Portainer stack and repull.`;
    case "quota":
      return "Out of credits or over quota. Check billing on the provider's dashboard.";
    case "model_unavailable":
      return "The model it's configured to use wasn't found — it may have been retired. Needs a code change to a current model.";
    case "rate_limit":
      return "Still rate-limited after automatic retries. Usually clears on its own; if it persists, the plan's limits are too low for current usage.";
    case "timeout":
      return "Requests are timing out even after automatic retries. Usually a provider-side slowdown; no action unless it persists.";
    case "provider_down":
      return "The provider is returning server errors even after automatic retries — likely an outage on their side. No action unless it persists.";
    case "bad_response":
      return "Replies can't be parsed, even after a retry. If it persists, the model may have changed behavior.";
    default:
      return "Failing with an unexpected error. Check the container logs for the full message.";
  }
}

const KIND_LABEL: Record<FailureKind, string> = {
  auth: "API key rejected",
  quota: "out of credits / quota",
  model_unavailable: "model not found",
  rate_limit: "rate limited",
  timeout: "timing out",
  provider_down: "provider outage",
  bad_response: "unusable replies",
  unknown: "unexpected error",
};

export interface ProviderAlert {
  provider: string;
  status: "failing" | "recovered";
  kind?: FailureKind;
  /** Short human label for the failure, e.g. "API key rejected". */
  label?: string;
  advice?: string;
  consecutiveFailures?: number;
  failingSince?: number;
  /** True when this repeats an earlier alert for the same ongoing outage. */
  reminder?: boolean;
  /** Other providers currently working. Empty means AI is effectively down. */
  healthyOthers?: string[];
  timestamp: number;
}

interface ProviderState {
  consecutiveFailures: number;
  lastKind: FailureKind | null;
  failingSince: number | null;
  alerted: boolean;
  lastAlertAt: number;
}

export interface ProviderHealth {
  provider: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailure: string | null;
  failingSince: number | null;
}

const states = new Map<string, ProviderState>();
const listeners = new Set<(alert: ProviderAlert) => void>();

function stateFor(provider: string): ProviderState {
  let s = states.get(provider);
  if (!s) {
    s = { consecutiveFailures: 0, lastKind: null, failingSince: null, alerted: false, lastAlertAt: 0 };
    states.set(provider, s);
  }
  return s;
}

function healthyProvidersExcept(provider: string): string[] {
  return [...states.entries()]
    .filter(([name, s]) => name !== provider && s.consecutiveFailures === 0)
    .map(([name]) => name);
}

function emit(alert: ProviderAlert): void {
  const detail = alert.status === "failing" ? `${alert.label} — ${alert.advice}` : "working again";
  console.warn(`[Health] ${alert.provider} ${alert.status}${alert.reminder ? " (reminder)" : ""}: ${detail}`);
  for (const listener of listeners) {
    try {
      listener(alert);
    } catch (err) {
      console.error("[Health] Alert listener failed:", err);
    }
  }
}

/** Subscribe to provider alerts. Returns an unsubscribe function. */
export function onProviderAlert(listener: (alert: ProviderAlert) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordSuccess(provider: string, now = Date.now()): void {
  const s = stateFor(provider);
  if (s.alerted) {
    emit({ provider, status: "recovered", failingSince: s.failingSince ?? undefined, timestamp: now });
  }
  s.consecutiveFailures = 0;
  s.lastKind = null;
  s.failingSince = null;
  s.alerted = false;
}

export function recordFailure(provider: string, err: unknown, now = Date.now()): FailureKind {
  const kind = classifyProviderError(err);
  const s = stateFor(provider);
  s.consecutiveFailures++;
  s.lastKind = kind;
  if (s.failingSince === null) s.failingSince = now;

  const firstAlert =
    !s.alerted && (NEEDS_ACTION.has(kind) || s.consecutiveFailures >= TRANSIENT_ALERT_AFTER);
  const reminder = s.alerted && now - s.lastAlertAt >= REMINDER_INTERVAL_MS;

  if (firstAlert || reminder) {
    s.alerted = true;
    s.lastAlertAt = now;
    emit({
      provider,
      status: "failing",
      kind,
      label: KIND_LABEL[kind],
      advice: adviceFor(provider, kind),
      consecutiveFailures: s.consecutiveFailures,
      failingSince: s.failingSince,
      reminder,
      healthyOthers: healthyProvidersExcept(provider),
      timestamp: now,
    });
  }
  return kind;
}

/**
 * Run a provider call and record the outcome. Rethrows the original error so
 * callers keep their existing fallback behavior.
 */
export async function tracked<T>(provider: string, call: () => Promise<T>): Promise<T> {
  try {
    const result = await call();
    recordSuccess(provider);
    return result;
  } catch (err) {
    recordFailure(provider, err);
    throw err;
  }
}

/** Current status of every provider that has been called. */
export function getProviderHealth(): ProviderHealth[] {
  return [...states.entries()].map(([provider, s]) => ({
    provider,
    healthy: s.consecutiveFailures === 0,
    consecutiveFailures: s.consecutiveFailures,
    lastFailure: s.lastKind ? KIND_LABEL[s.lastKind] : null,
    failingSince: s.failingSince,
  }));
}

/** Test helper. */
export function _resetProviderHealth(): void {
  states.clear();
  listeners.clear();
}
