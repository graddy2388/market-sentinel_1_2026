import { describe, it, expect } from "vitest";
import { safeFetchImage } from "../src/ai/safe-fetch.js";

describe("safeFetchImage", () => {
  it("rejects non-HTTPS URLs", async () => {
    await expect(safeFetchImage("http://cdn.discordapp.com/image.png")).rejects.toThrow("HTTPS");
  });

  it("rejects non-Discord hosts", async () => {
    await expect(safeFetchImage("https://evil.com/image.png")).rejects.toThrow("not allowed");
  });

  it("rejects internal network addresses", async () => {
    await expect(safeFetchImage("https://169.254.169.254/latest/meta-data/")).rejects.toThrow("not allowed");
  });

  it("rejects localhost", async () => {
    await expect(safeFetchImage("https://localhost:8080/admin")).rejects.toThrow("not allowed");
  });

  it("rejects invalid URLs", async () => {
    await expect(safeFetchImage("not-a-url")).rejects.toThrow("Invalid image URL");
  });

  it("rejects FTP scheme", async () => {
    await expect(safeFetchImage("ftp://cdn.discordapp.com/image.png")).rejects.toThrow("HTTPS");
  });

  it("rejects data: URIs", async () => {
    await expect(safeFetchImage("data:image/png;base64,abc")).rejects.toThrow("HTTPS");
  });

  it("rejects file: URIs", async () => {
    await expect(safeFetchImage("file:///etc/passwd")).rejects.toThrow("HTTPS");
  });

  it("allows cdn.discordapp.com", async () => {
    // This will fail at the network level (no real file), but should NOT fail at validation
    const result = safeFetchImage("https://cdn.discordapp.com/attachments/fake/fake/image.png");
    // Expect a network error, not a validation error
    await expect(result).rejects.not.toThrow("not allowed");
    await expect(result).rejects.not.toThrow("HTTPS");
  });

  it("allows media.discordapp.net", async () => {
    const result = safeFetchImage("https://media.discordapp.net/attachments/fake/fake/image.png");
    await expect(result).rejects.not.toThrow("not allowed");
    await expect(result).rejects.not.toThrow("HTTPS");
  });
});
