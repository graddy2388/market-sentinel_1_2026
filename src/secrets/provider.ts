/**
 * Secret provider abstraction.
 *
 * Two modes, selected by SECRETS_PROVIDER:
 * - "env" (default): no-op. Secrets come from the environment / .env as today.
 * - "onepassword": any environment variable whose value is a 1Password secret
 *   reference (op://vault/item/field) is resolved to its real value at startup.
 *
 * The references themselves are NOT secret — they can live in compose and show
 * up in `docker inspect` safely. The resolved secrets are written into
 * process.env in memory by the preloader (see preload.ts), so they never appear
 * in the container's create-time environment.
 *
 * Auth uses a 1Password service-account token, read from a FILE (OP_TOKEN_FILE)
 * so the token itself stays out of the inspectable environment too. The same
 * code works against a self-hosted 1Password Connect server if that token type
 * is supplied instead.
 *
 * IMPORTANT: this module must not import config.ts (directly or transitively),
 * because it runs before config is allowed to read the environment.
 */
import { readFile } from "fs/promises";

export type SecretsProviderKind = "env" | "onepassword";

const OP_REFERENCE_PREFIX = "op://";

/** Resolve the configured provider kind (defaults to "env"). */
export function getSecretsProviderKind(raw = process.env.SECRETS_PROVIDER): SecretsProviderKind {
  return (raw ?? "env").trim().toLowerCase() === "onepassword" ? "onepassword" : "env";
}

/** Find env entries whose value is a 1Password secret reference (op://...). */
export function findSecretReferences(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.startsWith(OP_REFERENCE_PREFIX)) out.push([k, v]);
  }
  return out;
}

/**
 * Read the 1Password service-account token. Prefers OP_TOKEN_FILE (a path to a
 * mounted secret file) over OP_SERVICE_ACCOUNT_TOKEN (inline env) so the token
 * stays out of `docker inspect`.
 */
export async function readServiceAccountToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = env.OP_TOKEN_FILE;
  if (file) {
    const token = (await readFile(file, "utf8")).trim();
    if (!token) throw new Error(`OP_TOKEN_FILE (${file}) is empty`);
    return token;
  }
  const inline = env.OP_SERVICE_ACCOUNT_TOKEN?.trim();
  if (inline) return inline;
  throw new Error(
    "No 1Password token found. Set OP_TOKEN_FILE (path to a token file) or OP_SERVICE_ACCOUNT_TOKEN."
  );
}

/**
 * Resolve all op:// references found in the environment to their secret values.
 * Returns a map of env-var name -> resolved secret. Throws on any failure
 * (fail fast — never silently start with missing keys).
 *
 * No-op (returns {}) when the provider is "env".
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  if (getSecretsProviderKind(env.SECRETS_PROVIDER) === "env") return {};

  const refs = findSecretReferences(env);
  if (refs.length === 0) {
    console.warn(
      "[secrets] SECRETS_PROVIDER=onepassword but no op:// references found in the environment — nothing to resolve."
    );
    return {};
  }

  const token = await readServiceAccountToken(env);

  // Imported lazily so the env-only path never loads the SDK.
  const { createClient } = await import("@1password/sdk");
  const client = await createClient({
    auth: token,
    integrationName: "Market Sentinel",
    integrationVersion: "1.0.0",
  });

  const resolved: Record<string, string> = {};
  for (const [key, ref] of refs) {
    try {
      resolved[key] = await client.secrets.resolve(ref);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to resolve ${key} from 1Password (${ref}): ${msg}`);
    }
  }

  console.log(`[secrets] Resolved ${refs.length} secret(s) from 1Password.`);
  return resolved;
}
