/**
 * Mock webhook HTTP server for testing event trigger delivery.
 *
 * Listens on an OS-assigned port on 127.0.0.1, records all incoming
 * requests, and supports configurable response codes and delays for
 * simulating failures, timeouts, and success scenarios.
 */

import * as http from 'node:http';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  timestamp: number;
}

// ─── Mock Webhook Server ───────────────────────────────────────────────────

export class MockWebhookServer {
  private server: http.Server | null = null;
  private _requests: RecordedRequest[] = [];
  private _responseCode: number = 200;
  private _responseDelayMs: number = 0;
  private _port: number = 0;
  private waiters: Array<{ count: number; resolve: () => void }> = [];

  /** All requests received since last reset. */
  get requests(): ReadonlyArray<RecordedRequest> {
    return this._requests;
  }

  /** The port the server is listening on. Only valid after start(). */
  get port(): number {
    return this._port;
  }

  /** The base URL (http://127.0.0.1:<port>) for building webhook URLs. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  /** Set the HTTP status code to respond with for subsequent requests. */
  set responseCode(code: number) {
    this._responseCode = code;
  }

  /** Set an artificial delay (ms) before responding to requests. */
  set responseDelay(ms: number) {
    this._responseDelayMs = ms;
  }

  /**
   * Start the server on an OS-assigned port on 127.0.0.1.
   */
  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }

      const recorded: RecordedRequest = {
        method: req.method ?? 'UNKNOWN',
        url: req.url ?? '/',
        headers: req.headers,
        body,
        timestamp: Date.now(),
      };
      this._requests.push(recorded);

      // Notify any waiters
      this.checkWaiters();

      // Apply configured delay
      if (this._responseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this._responseDelayMs));
      }

      res.writeHead(this._responseCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: this._responseCode < 400 }));
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        resolve();
      });
    });
  }

  /**
   * Stop the server and release the port.
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.server = null;
    this._port = 0;
  }

  /**
   * Wait until at least `count` requests have been received.
   * Rejects after `timeoutMs` if the count is not reached.
   */
  async waitForRequests(count: number, timeoutMs: number = 10000): Promise<RecordedRequest[]> {
    if (this._requests.length >= count) {
      return this._requests.slice(0, count);
    }

    return new Promise<RecordedRequest[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(
          new Error(
            `Timed out waiting for ${count} request(s) after ${timeoutMs}ms ` +
            `(received ${this._requests.length})`,
          ),
        );
      }, timeoutMs);

      const done = () => {
        clearTimeout(timer);
        resolve(this._requests.slice(0, count));
      };

      this.waiters.push({ count, resolve: done });
    });
  }

  /**
   * Clear all recorded requests and reset response settings.
   */
  reset(): void {
    this._requests = [];
    this._responseCode = 200;
    this._responseDelayMs = 0;
    this.waiters = [];
  }

  private checkWaiters(): void {
    const satisfied: Array<{ count: number; resolve: () => void }> = [];
    const remaining: Array<{ count: number; resolve: () => void }> = [];

    for (const waiter of this.waiters) {
      if (this._requests.length >= waiter.count) {
        satisfied.push(waiter);
      } else {
        remaining.push(waiter);
      }
    }

    this.waiters = remaining;
    for (const waiter of satisfied) {
      waiter.resolve();
    }
  }
}
