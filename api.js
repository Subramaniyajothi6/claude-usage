// Network layer, kept free of the `vscode` module so it can be unit-tested
// with a mocked fetch implementation.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Fetch usage from Anthropic's OAuth usage endpoint.
 * @param {string} token  OAuth access token.
 * @param {typeof fetch} [fetchImpl]  Injectable fetch (defaults to global).
 */
async function fetchUsage(token, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const res = await f(USAGE_URL, {
    headers: {
      Authorization: "Bearer " + token,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "User-Agent": "claude-usage-vscode/0.2.0",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${body.slice(0, 160)}`);
  }
  return res.json();
}

/**
 * Exchange a refresh token for a fresh access token.
 * Returns the parsed token response: { access_token, refresh_token, expires_in }.
 * @param {string} refreshToken
 * @param {typeof fetch} [fetchImpl]
 */
async function refreshToken(refreshToken, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`token refresh failed: ${res.status} ${body.slice(0, 160)}`);
  }
  return res.json();
}

module.exports = { USAGE_URL, TOKEN_URL, CLIENT_ID, fetchUsage, refreshToken };
