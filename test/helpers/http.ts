import type { FetchLike } from "../../src/http/httpClient.js";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type ScriptedReply =
  Response | ((request: RecordedRequest) => Response | Promise<Response>);

/** Build a real Fetch Response without copying provider payloads from captures. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Deterministic fetch queue used by provider tests; no request reaches a network. */
export function scriptedFetch(replies: readonly ScriptedReply[]): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetch = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });

    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }

    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    };
    requests.push(request);

    const reply = replies[index++];
    if (!reply) throw new Error("scriptedFetch: no reply left for request");
    return typeof reply === "function" ? reply(request) : reply;
  }) as unknown as FetchLike;

  return { fetch, requests };
}
