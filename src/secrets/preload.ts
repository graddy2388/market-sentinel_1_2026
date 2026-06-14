/**
 * Secret preloader.
 *
 * Resolves any 1Password references in the environment and writes the secrets
 * into process.env IN MEMORY, before config.ts is allowed to read them. This is
 * a no-op for the default "env" provider.
 *
 * Must run before any config-dependent import. Entry points (bootstrap.ts,
 * index.ts) call this and then dynamically import the rest of the app.
 */
import { loadSecrets } from "./provider.js";

export async function preloadSecrets(): Promise<void> {
  const resolved = await loadSecrets();
  for (const [key, value] of Object.entries(resolved)) {
    process.env[key] = value;
  }
}
