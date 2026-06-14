import { describe, it, expect, afterAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, rmSync } from "fs";
import {
  getSecretsProviderKind,
  findSecretReferences,
  readServiceAccountToken,
  loadSecrets,
} from "../src/secrets/provider.js";

const tmpFiles: string[] = [];
function tempTokenFile(contents: string): string {
  const p = join(tmpdir(), `op-token-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(p, contents);
  tmpFiles.push(p);
  return p;
}

afterAll(() => {
  for (const f of tmpFiles) {
    try { rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

describe("getSecretsProviderKind", () => {
  it("defaults to env", () => {
    expect(getSecretsProviderKind(undefined)).toBe("env");
  });
  it("recognizes onepassword (case-insensitive, trimmed)", () => {
    expect(getSecretsProviderKind("onepassword")).toBe("onepassword");
    expect(getSecretsProviderKind("OnePassword")).toBe("onepassword");
    expect(getSecretsProviderKind("  onepassword  ")).toBe("onepassword");
  });
  it("falls back to env for unknown values", () => {
    expect(getSecretsProviderKind("vault")).toBe("env");
    expect(getSecretsProviderKind("")).toBe("env");
  });
});

describe("findSecretReferences", () => {
  it("picks env values that are op:// references", () => {
    const env = {
      OPENAI_API_KEY: "op://market-sentinel/openai/credential",
      ANTHROPIC_API_KEY: "op://market-sentinel/anthropic/credential",
      MCP_PORT: "3100",
      DISCORD_CHANNEL_ID: "1472746341653286944",
      PLAIN_KEY: "sk-not-a-ref",
    } as unknown as NodeJS.ProcessEnv;
    const refs = findSecretReferences(env);
    const keys = refs.map(([k]) => k).sort();
    expect(keys).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(refs.find(([k]) => k === "OPENAI_API_KEY")?.[1]).toBe("op://market-sentinel/openai/credential");
  });
  it("returns empty when there are no references", () => {
    expect(findSecretReferences({ FOO: "bar" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("readServiceAccountToken", () => {
  it("reads and trims a token from OP_TOKEN_FILE", async () => {
    const file = tempTokenFile("  ops_sometoken\n");
    const token = await readServiceAccountToken({ OP_TOKEN_FILE: file } as NodeJS.ProcessEnv);
    expect(token).toBe("ops_sometoken");
  });
  it("throws when OP_TOKEN_FILE is empty", async () => {
    const file = tempTokenFile("   \n");
    await expect(readServiceAccountToken({ OP_TOKEN_FILE: file } as NodeJS.ProcessEnv)).rejects.toThrow("empty");
  });
  it("falls back to OP_SERVICE_ACCOUNT_TOKEN", async () => {
    const token = await readServiceAccountToken({ OP_SERVICE_ACCOUNT_TOKEN: "ops_inline" } as NodeJS.ProcessEnv);
    expect(token).toBe("ops_inline");
  });
  it("prefers OP_TOKEN_FILE over the inline token", async () => {
    const file = tempTokenFile("ops_fromfile");
    const token = await readServiceAccountToken({
      OP_TOKEN_FILE: file,
      OP_SERVICE_ACCOUNT_TOKEN: "ops_inline",
    } as NodeJS.ProcessEnv);
    expect(token).toBe("ops_fromfile");
  });
  it("throws when no token is configured", async () => {
    await expect(readServiceAccountToken({} as NodeJS.ProcessEnv)).rejects.toThrow(/OP_TOKEN_FILE|OP_SERVICE_ACCOUNT_TOKEN/);
  });
});

describe("loadSecrets", () => {
  it("is a no-op for the env provider", async () => {
    const env = {
      SECRETS_PROVIDER: "env",
      OPENAI_API_KEY: "op://market-sentinel/openai/credential",
    } as unknown as NodeJS.ProcessEnv;
    expect(await loadSecrets(env)).toEqual({});
  });

  it("returns empty (without touching the SDK) when no references are present", async () => {
    const env = {
      SECRETS_PROVIDER: "onepassword",
      MCP_PORT: "3100",
    } as unknown as NodeJS.ProcessEnv;
    // No op:// refs → returns before reading the token or importing the SDK.
    expect(await loadSecrets(env)).toEqual({});
  });
});
