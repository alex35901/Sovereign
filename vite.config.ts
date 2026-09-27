import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Serves the api/ folder during `npm run dev`, the way Vercel does in
 * production: same (req, res) signature, same parsed `body`.
 *
 * Without this the dev server returns the SPA shell for /api/*, so every
 * provider and the cross-device sync appear broken locally for reasons that
 * have nothing to do with their code.
 */
function apiFunctions(): Plugin {
  return {
    name: "api-functions",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/")) return next();

        const route = url.split("?")[0].replace(/^\/api\//, "").replace(/\/$/, "");
        const candidates = [`api/${route}.ts`, `api/${route}/index.ts`];
        const file = candidates.find((c) => existsSync(resolve(process.cwd(), c)));
        if (!file) return next();

        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            try {
              const mod = await server.ssrLoadModule(`/${file}`);
              const handler = (mod as { default?: unknown }).default;
              if (typeof handler !== "function") throw new Error(`${file} has no default export`);
              // Vercel hands the handler a parsed body; match that exactly.
              (req as { body?: unknown }).body = raw ? JSON.parse(raw) : undefined;
              await (handler as (q: unknown, s: unknown) => unknown)(req, res);
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : "dev handler failed" }));
            }
          })();
        });
      });
    },
  };
}

/**
 * When this bundle was built, baked in so a tab can say how old it is.
 *
 * A browser tab runs the JavaScript it loaded with until it is closed or
 * reloaded. A deploy reaches nobody who already has the app open, so a tab
 * carrying a bug goes on carrying it, and there is no way to fix it from here.
 * The server refuses a write from a build older than the one that last wrote,
 * and this is the number it compares. Milliseconds, so it only ever goes up.
 */
const BUILD = Date.now();

export default defineConfig({
  plugins: [react(), apiFunctions()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  server: { port: 5273 },
});
