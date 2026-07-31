import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetry } from "../scripts/lib-github-content.mjs";

test("retries transient HTTP failures before returning a successful response", async () => {
  const responses = [
    new Response(null, { status: 504, statusText: "Gateway Timeout" }),
    new Response("ok", { status: 200 }),
  ];
  const delays = [];
  const retries = [];

  const response = await fetchWithRetry("https://api.github.com/example", {}, {
    baseDelayMs: 25,
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (delayMs) => delays.push(delayMs),
    onRetry: (retry) => retries.push(retry),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(delays, [25]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].status, 504);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].attempts, 3);
});

test("honors Retry-After for rate limits", async () => {
  const responses = [
    new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
    new Response("ok", { status: 200 }),
  ];
  const delays = [];

  const response = await fetchWithRetry("https://api.github.com/example", {}, {
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (delayMs) => delays.push(delayMs),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(delays, [2000]);
});

test("does not retry permanent HTTP failures", async () => {
  let calls = 0;
  const response = await fetchWithRetry("https://api.github.com/example", {}, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 404, statusText: "Not Found" });
    },
    sleepImpl: async () => assert.fail("sleep should not be called"),
  });

  assert.equal(response.status, 404);
  assert.equal(calls, 1);
});

test("retries network errors and exposes the final failure", async () => {
  let calls = 0;
  const delays = [];

  await assert.rejects(
    fetchWithRetry("https://api.github.com/example", {}, {
      attempts: 3,
      baseDelayMs: 10,
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
      sleepImpl: async (delayMs) => delays.push(delayMs),
    }),
    /fetch failed/,
  );

  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});
