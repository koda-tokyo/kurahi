// Test helpers for business connectors: an in-memory secret store and a recorded-fetch mock.
// No test reaches a real Microsoft or Google endpoint: every request is answered from here.
import type { SecretStore } from "../../secrets/types.js";
import type { FetchLike } from "./http.js";

export class MemorySecretStore implements SecretStore {
  readonly backend = "file" as const;
  readonly location = "memory";
  readonly values = new Map<string, string>();
  get(name: string) {
    return this.values.get(name);
  }
  set(name: string, value: string) {
    this.values.set(name, value);
  }
  delete(name: string) {
    return this.values.delete(name);
  }
  list() {
    return [...this.values.keys()].toSorted();
  }
}

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

export type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that records every request and answers from `routes` in order; unknown -> throws. */
export function mockFetch(routes: Route[]): FetchLike & { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fn = (async (input: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req: RecordedRequest = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(req);
    for (const route of routes) {
      const res = await route(req);
      if (res) {
        return res;
      }
    }
    throw new Error(`unexpected request in test: ${req.method} ${req.url}`);
  }) as FetchLike & { calls: RecordedRequest[] };
  fn.calls = calls;
  return fn;
}

/** Route helper: match method + URL prefix (or predicate); `respond` may be a queue. */
export function on(
  method: string,
  match: string | RegExp,
  respond: (req: RecordedRequest) => Response | Promise<Response>,
): Route {
  return (req) => {
    if (req.method !== method) {
      return undefined;
    }
    const hit = typeof match === "string" ? req.url.startsWith(match) : match.test(req.url);
    return hit ? respond(req) : undefined;
  };
}

/** Responses served in order; the last one repeats. */
export function queue(...responses: Array<() => Response>): () => Response {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)]();
}

export const noSleep = async () => {};
