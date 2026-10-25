export class DataSourceError extends Error {
  constructor(
    message: string,
    readonly reason: "config" | "refused" | "auth" | "network" | "protocol" | "remote" | "limit",
    readonly status?: number,
  ) {
    super(message);
    this.name = "DataSourceError";
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read a JSON body of at most `limit` bytes. */
export async function readJsonBounded(res: Response, limit: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new DataSourceError(`response exceeds ${limit} bytes`, "limit");
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DataSourceError(
      `the server returned invalid JSON (HTTP ${res.status})`,
      "protocol",
      res.status,
    );
  }
}

export async function send(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchFn(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new DataSourceError(
      timedOut ? `no answer within ${timeoutMs} ms` : "the server is unreachable",
      "network",
    );
  }
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}
