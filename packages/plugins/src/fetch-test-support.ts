/**
 * A `fetch` stub for the tests of an integration that calls its vendor through
 * `callExternal`. `ExternalTransport` reads `globalThis.fetch` on every call,
 * so replacing the global decides what the vendor answers.
 *
 * Call `recordFetch` at the top level of a test file. It registers Vitest hooks
 * there: before each test it installs the stub and clears what was recorded,
 * and after each test it puts the original `fetch` back.
 */

import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { afterEach, beforeEach } from "vitest";

/**
 * How the stubbed vendor answers one request. `body` is the request's body
 * read as a JSON object, or undefined when the request carried none.
 */
export type FetchResponder = (
  request: Request,
  body: JsonObject | undefined
) => Response | Promise<Response>;

export type RecordedFetch = {
  /** Every request sent in the current test, in the order it was sent. */
  readonly requests: readonly Request[];
  /** Answer the requests sent from now until the end of the current test. */
  answer: (respond: FetchResponder) => void;
  /** The JSON object body of the request at `index`. Throws when it has none. */
  body: (index: number) => JsonObject;
  /** The JSON object body of every request sent in the current test. */
  bodies: () => JsonObject[];
};

type SentRequest = { request: Request; body: JsonObject | undefined };

/**
 * Install a recording `fetch` stub for each test in the calling file.
 * `respond` is how the stub answers at the start of every test, until the test
 * calls `answer`.
 */
export function recordFetch(respond: FetchResponder): RecordedFetch {
  const sent: SentRequest[] = [];
  let responder = respond;
  let realFetch: typeof fetch | undefined;

  async function stub(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const request = new Request(input, init);
    const text = await request.clone().text();
    const parsed =
      text === "" ? undefined : (readJsonObject(JSON.parse(text)) ?? undefined);
    sent.push({ request, body: parsed });
    return responder(request.clone(), parsed);
  }

  function body(index: number): JsonObject {
    const entry = sent[index];
    if (entry === undefined) {
      throw new Error(`no request ${index} was sent`);
    }
    if (entry.body === undefined) {
      throw new Error(`request ${index} carried no JSON object body`);
    }
    return entry.body;
  }

  beforeEach(() => {
    sent.length = 0;
    responder = respond;
    realFetch = globalThis.fetch;
    globalThis.fetch = stub;
  });

  afterEach(() => {
    if (realFetch !== undefined) {
      globalThis.fetch = realFetch;
    }
  });

  return {
    get requests() {
      return sent.map(({ request }) => request);
    },
    answer: (next) => {
      responder = next;
    },
    body,
    bodies: () => sent.map((_, index) => body(index)),
  };
}
