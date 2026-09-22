/**
 * Model choices, in one place.
 *
 * Prices are per million tokens, checked 2026-09-22. They live here because
 * the cost of a model choice isn't visible at the call site: a council run is
 * ~400 input / ~300 output tokens and refreshes at most 4x/hour per watched
 * symbol, so a rough monthly cost per continuously watched coin is
 *
 *     $/coin-month  ≈  1.152 × input$  +  0.864 × output$
 *
 * Two constraints shaped these picks:
 * - The council and chat both use Chat Completions with `temperature` and
 *   `max_tokens`, and read a plain text reply. OpenAI's reasoning models
 *   (gpt-5/gpt-6 families) want different parameters and bill reasoning tokens
 *   as output, so the OpenAI seat uses the newest NON-reasoning model.
 * - Claude thinking is disabled explicitly at every call site. On Sonnet 5 it
 *   is on by default, which would bill thinking tokens as output and put a
 *   thinking block where the code expects text.
 */

export const MODELS = {
  /** Anthropic seat + chat. $2/$10 per MTok ≈ $10.94 per coin-month. */
  claude: "claude-sonnet-5",

  /** OpenAI seat + chat fallback. Non-reasoning. $2/$8 ≈ $9.22 per coin-month. */
  openai: "gpt-4.1",

  /**
   * Open-weight third voter on Groq. $0.15/$0.60 ≈ $0.69 per coin-month —
   * near-free, and a third independent lineage is what makes "majority" mean
   * something: with only two voters, any disagreement collapses to neutral.
   * Needs GROQ_API_KEY; the seat is simply absent without one.
   */
  groq: "openai/gpt-oss-120b",

  // Seats with no key configured. The IDs below are unverified and likely
  // stale — check the provider's current catalogue before adding a key.
  gemini: "gemini-2.0-flash",
  cohere: "command-r-plus",
  mistral: "mistral-small-latest",
  deepseek: "deepseek-chat",
} as const;
