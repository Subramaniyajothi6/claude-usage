const test = require("node:test");
const assert = require("node:assert");
const { fetchUsage, refreshToken, USAGE_URL, TOKEN_URL, CLIENT_ID } = require("../api");

// Build a fake fetch that records its call and returns a canned response.
function fakeFetch(response) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
  fn.calls = calls;
  return fn;
}

const okResponse = (json) => ({
  ok: true,
  status: 200,
  json: async () => json,
  text: async () => JSON.stringify(json),
});

const errResponse = (status, body) => ({
  ok: false,
  status,
  json: async () => {
    throw new Error("not json");
  },
  text: async () => body,
});

test("sends the right URL and auth headers", async () => {
  const f = fakeFetch(okResponse({ five_hour: { utilization: 1 } }));
  await fetchUsage("tok-123", f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, USAGE_URL);
  const h = f.calls[0].opts.headers;
  assert.equal(h.Authorization, "Bearer tok-123");
  assert.equal(h["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(h["anthropic-version"], "2023-06-01");
});

test("returns parsed JSON on 200", async () => {
  const data = { five_hour: { utilization: 17 }, seven_day: { utilization: 7 } };
  const f = fakeFetch(okResponse(data));
  const out = await fetchUsage("tok", f);
  assert.deepEqual(out, data);
});

test("throws with status + body on 429", async () => {
  const f = fakeFetch(errResponse(429, '{"error":"Rate limited"}'));
  await assert.rejects(() => fetchUsage("tok", f), /^Error: 429 /);
});

test("throws on other non-2xx", async () => {
  const f = fakeFetch(errResponse(401, "unauthorized"));
  await assert.rejects(() => fetchUsage("tok", f), /^Error: 401 /);
});

test("refreshToken posts grant_type + client_id and returns new tokens", async () => {
  const f = fakeFetch(
    okResponse({ access_token: "new-acc", refresh_token: "new-ref", expires_in: 3600 })
  );
  const out = await refreshToken("old-ref", f);
  assert.equal(f.calls[0].url, TOKEN_URL);
  assert.equal(f.calls[0].opts.method, "POST");
  const body = JSON.parse(f.calls[0].opts.body);
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "old-ref");
  assert.equal(body.client_id, CLIENT_ID);
  assert.equal(out.access_token, "new-acc");
});

test("refreshToken throws on failure", async () => {
  const f = fakeFetch(errResponse(400, "invalid_grant"));
  await assert.rejects(() => refreshToken("bad", f), /token refresh failed: 400/);
});
