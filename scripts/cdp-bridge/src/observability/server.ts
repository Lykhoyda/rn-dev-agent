import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Recorder } from "./recorder.js";

const HOST = "127.0.0.1";
const __dir = dirname(fileURLToPath(import.meta.url));

export class ObservabilityServer {
  private server: Server | null = null;
  private port = 0;
  private streams = new Set<ServerResponse>();
  constructor(private readonly recorder: Recorder) {}

  async start(preferredPort?: number): Promise<{ url: string; port: number }> {
    if (this.server) return { url: this.url(), port: this.port };
    const server = createServer((req, res) => this.handle(req, res));
    // SSE responses are long-lived, so disable the body timeout. But keep a
    // small headersTimeout so a connection that stalls mid-request-headers
    // (slow-loris) is closed instead of held open forever — SSE clients send
    // their headers immediately, so 5s is ample.
    server.requestTimeout = 0;
    server.headersTimeout = 5_000;
    try {
      this.port = await listen(server, preferredPort ?? 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && preferredPort) {
        this.port = await listen(server, 0);
      } else {
        throw e;
      }
    }
    this.server = server;
    return { url: this.url(), port: this.port };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    // Tell live SSE clients we're shutting down BEFORE yanking the sockets, so
    // the browser's EventSource closes instead of entering its auto-reconnect
    // loop (which would otherwise hammer the dead port, or silently reattach to
    // a different session started later on the same port).
    for (const res of this.streams) {
      try {
        res.write('data: {"type":"shutdown"}\n\n');
        res.end();
      } catch {
        /* already closed */
      }
    }
    this.streams.clear();
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private url(): string {
    return `http://${HOST}:${this.port}`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.guard(req, res)) return;
    const url = req.url ?? "/";
    if (url === "/api/stream") return this.stream(res);
    const shot = /^\/api\/screenshot\/(\d+)$/.exec(url);
    if (shot) return this.screenshot(Number(shot[1]), res);
    if (/^\/api\/live-screenshot\/\d+$/.test(url)) return this.liveScreenshot(res);
    if (url === "/") return this.index(res);
    res.writeHead(404);
    res.end();
  }

  private stream(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    res.socket?.setTimeout(0);
    const write = (ev: unknown): boolean => {
      try {
        return res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        return false;
      }
    };
    this.streams.add(res);
    const { snapshot, detach } = this.recorder.attach((ev) => {
      // Recorder.clear() emits a terminal sentinel — end the stream cleanly.
      if ((ev as { type?: string }).type === "cleared") {
        detach();
        res.end();
        return;
      }
      if (!write(ev)) {
        detach();
        res.end();
      }
    });
    write({ type: "snapshot", events: snapshot });
    const hb = setInterval(() => {
      try {
        res.write(": hb\n\n");
      } catch {
        /* closed */
      }
    }, 15_000);
    hb.unref?.();
    res.on("close", () => {
      clearInterval(hb);
      detach();
      this.streams.delete(res);
    });
  }

  private guard(req: IncomingMessage, res: ServerResponse): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const okHost =
      host === `127.0.0.1:${this.port}` ||
      host === `localhost:${this.port}` ||
      host === "127.0.0.1" ||
      host === "localhost";
    const site = req.headers["sec-fetch-site"];
    const okSite = site === undefined || site === "same-origin" || site === "none";
    if (!okHost || !okSite) {
      res.writeHead(403);
      res.end("forbidden");
      return false;
    }
    return true;
  }

  private screenshot(seq: number, res: ServerResponse): void {
    const shot = this.recorder.getScreenshot(seq);
    if (!shot) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": shot.contentType, "Cache-Control": "no-store" });
    res.end(shot.buf);
  }

  private liveScreenshot(res: ServerResponse): void {
    // The <seq> in the path is a cache-busting key only — always serve the
    // current live frame; 404 only when none has been captured this session.
    const shot = this.recorder.getLiveScreenshot();
    if (!shot) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": shot.contentType, "Cache-Control": "no-store" });
    res.end(shot.buf);
  }

  private index(res: ServerResponse): void {
    try {
      // __dir is dist/observability/; the SPA bundle ships at
      // dist/observability/web-dist/index.html (vite outDir).
      const html = readFileSync(join(__dir, "web-dist", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(503);
      res.end("SPA bundle not built — run npm run build:web");
    }
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error): void => {
      server.removeListener("error", onErr);
      reject(e);
    };
    server.once("error", onErr);
    server.listen(port, HOST, () => {
      server.removeListener("error", onErr);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
