// Copy non-TypeScript static assets into dist after `tsc`.
// tsc only emits compiled .js — the dashboard's HTML/CSS/client-JS live under
// src/interfaces/web/public and must be copied verbatim so they ship in the
// Docker image (which only carries /app/dist).
import { cpSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const copies = [
  ["src/interfaces/web/public", "dist/interfaces/web/public"],
];

for (const [from, to] of copies) {
  const src = resolve(root, from);
  const dest = resolve(root, to);
  if (!existsSync(src)) {
    console.warn(`[copy-static] skip (missing): ${from}`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-static] ${from} -> ${to}`);
}
