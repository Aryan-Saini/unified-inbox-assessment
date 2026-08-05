import { vi } from "vitest";

export interface ProviderCall {
  host: string;
  path: string;
  url: string;
  method: string;
  init: RequestInit;
}

interface ScriptedResponse {
  promise: Promise<Response>;
}

export interface DeferredReply {
  resolve(status: number, body?: unknown): void;
  reject(error?: Error): void;
}

function response(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: text === "" ? undefined : { "content-type": "application/json" },
  });
}

/** A strict, queue-based fetch fake. Routes deliberately ignore query strings. */
export function fakeProviders() {
  const scripts = new Map<string, ScriptedResponse[]>();
  const calls: ProviderCall[] = [];
  const key = (host: string, path: string) => `${host}${path}`;

  const enqueue = (host: string, path: string, scripted: ScriptedResponse) => {
    const route = key(host, path);
    scripts.set(route, [...(scripts.get(route) ?? []), scripted]);
  };

  const router = {
    calls,
    on(host: string, path: string) {
      return {
        reply(status: number, body?: unknown) {
          enqueue(host, path, { promise: Promise.resolve(response(status, body)) });
          return router;
        },
        deferred(): DeferredReply {
          let resolvePromise!: (value: Response) => void;
          let rejectPromise!: (reason: Error) => void;
          const promise = new Promise<Response>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
          });
          // A test may reject before the request under test has attached to the
          // promise (e.g. simulating a socket reset scripted up front). This
          // no-op observer keeps that window from tripping vitest's
          // unhandled-rejection detector; the fetch caller still sees the
          // rejection through its own await.
          void promise.catch(() => undefined);
          enqueue(host, path, { promise });
          return {
            resolve: (status, body) => resolvePromise(response(status, body)),
            reject: (error = new DOMException("The operation was aborted", "AbortError")) =>
              rejectPromise(error),
          };
        },
      };
    },
    matching(host: string, path: string) {
      return calls.filter((call) => call.host === host && call.path === path);
    },
    install() {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const call: ProviderCall = {
          host: url.host,
          path: url.pathname,
          url: url.toString(),
          method: (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
          init,
        };
        calls.push(call);
        const route = key(call.host, call.path);
        const queue = scripts.get(route);
        const scripted = queue?.shift();
        if (scripted === undefined) {
          throw new Error(`Unexpected provider fetch: ${call.method} ${call.url}`);
        }
        const signal = init.signal;
        if (signal == null) return await scripted.promise;
        return await Promise.race([
          scripted.promise,
          new Promise<Response>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new DOMException("The operation was aborted", "AbortError"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          }),
        ]);
      });
      return router;
    },
  };

  return router;
}
