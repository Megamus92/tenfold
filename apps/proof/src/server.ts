/**
 * Fastify server for the proof page. Read-only: every route is a GET over the shared Ledger.
 * Views are cached 5 s per project so a screener polling the API does not hammer SQLite.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { logger, type Ledger, type ProjectConfig } from "@tenfold/core";
import { projectView, trackRecord, verifyView, type ProjectView, type TrackRecordEntry, type VerifyView } from "./api.js";
import { renderIndex, renderProjectPage } from "./html.js";

export interface ServerOptions {
  ledger: Ledger;
  /** Secret for the HMAC on /verify; empty disables nothing but makes the signature worthless. */
  signingSecret: string;
  /** Cache lifetime in ms, default 5000. */
  cacheTtlMs?: number;
  /** Clock, overridable for tests. */
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expires: number;
}

/** Tiny per-key TTL cache; values are plain JSON so sharing them between requests is safe. */
class TtlCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>();
  constructor(private readonly ttlMs: number) {}

  get(key: string, now: number, build: () => T): T {
    const hit = this.map.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = build();
    this.map.set(key, { value, expires: now + this.ttlMs });
    return value;
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

const PROJECT_ID = /^[a-z0-9-]{2,40}$/;
const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Build the Fastify app (not listening) so tests can use `inject`. */
export function buildServer(opts: ServerOptions): FastifyInstance {
  const { ledger, signingSecret } = opts;
  const ttl = opts.cacheTtlMs ?? 5000;
  const now = opts.now ?? (() => Date.now());
  const projects = new TtlCache<ProjectView | null>(ttl);
  const verifies = new TtlCache<VerifyView | null>(ttl);
  const track = new TtlCache<TrackRecordEntry[]>(ttl);

  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
  });

  app.addHook("onResponse", async (req, reply) => {
    logger.debug("proof request", { method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) });
  });

  /** Project by id, or undefined. Cached as null when unknown so a 404 storm is cheap too. */
  function viewById(id: string): ProjectView | null {
    if (!PROJECT_ID.test(id)) return null;
    return projects.get(id, now(), () => {
      const cfg = ledger.getProject(id);
      return cfg ? projectView(ledger, cfg, now()) : null;
    });
  }

  function cfgByMint(mint: string): ProjectConfig | undefined {
    return ledger.listProjects().find((p) => p.mint === mint);
  }

  app.get("/healthz", async () => ({ ok: true, ts: now() }));

  app.options("/*", async (_req, reply) => reply.code(204).send());

  app.get("/", async (_req, reply) => {
    const rows = track.get("all", now(), () => trackRecord(ledger, now()));
    return reply.type("text/html; charset=utf-8").send(renderIndex(rows));
  });

  app.get<{ Params: { id: string } }>("/p/:id", async (req, reply) => {
    const v = viewById(req.params.id);
    if (!v) return reply.code(404).type("text/html; charset=utf-8").send(notFound("project"));
    return reply.type("text/html; charset=utf-8").send(renderProjectPage(v));
  });

  app.get<{ Params: { id: string } }>("/api/project/:id", async (req, reply) => {
    const v = viewById(req.params.id);
    if (!v) return reply.code(404).send({ error: "unknown project" });
    return reply.header("Cache-Control", `public, max-age=${Math.floor(ttl / 1000)}`).send(v);
  });

  app.get("/api/projects", async (_req, reply) => {
    const rows = track.get("all", now(), () => trackRecord(ledger, now()));
    return reply.header("Cache-Control", `public, max-age=${Math.floor(ttl / 1000)}`).send(rows);
  });

  app.get<{ Params: { mint: string } }>("/verify/:mint", async (req, reply) => {
    const mint = req.params.mint;
    if (!PUBKEY.test(mint)) return reply.code(404).send({ error: "unknown mint" });
    const v = verifies.get(mint, now(), () => {
      const cfg = cfgByMint(mint);
      return cfg ? verifyView(ledger, cfg, now(), signingSecret) : null;
    });
    if (!v) return reply.code(404).send({ error: "unknown mint" });
    return reply.header("Cache-Control", `public, max-age=${Math.floor(ttl / 1000)}`).send(v);
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.headers.accept?.includes("text/html")) return reply.code(404).type("text/html; charset=utf-8").send(notFound("page"));
    return reply.code(404).send({ error: "not found" });
  });

  return app;
}

function notFound(what: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found · Tenfold proof</title><style>body{margin:0;background:#0b0b0d;color:#e8e8ea;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}main{max-width:760px;margin:0 auto;padding:48px 16px}a{color:#f5c518}</style></head><body><main><h1>Unknown ${what}</h1><p><a href="/">All projects</a></p></main></body></html>`;
}
