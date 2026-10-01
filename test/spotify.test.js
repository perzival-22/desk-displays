import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import login from "../api/login.js";
import callback from "../api/callback.js";

function response() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.statusCode = n; return this; }, json(d) { this.body = d; },
    send(d) { this.body = d; }, redirect(d) { this.redirectUrl = d; } };
}

test("Spotify integration", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  Object.assign(process.env, { DASH_KEY: "test-key", SPOTIFY_CLIENT_ID: "test-id",
    SPOTIFY_CLIENT_SECRET: "test-secret", SPOTIFY_REFRESH_TOKEN: "test-refresh",
    SPOTIFY_REDIRECT_URI: "https://example.test/api/callback" });
  t.after(() => { process.env = originalEnv; global.fetch = originalFetch; });
  let importId = 0;
  const handler = async () => (await import(`../api/now-playing.js?test=${importId++}`)).default;
  const request = { query: { key: "test-key" } };

  await t.test("wrong dashboard key cannot call Spotify", async () => {
    global.fetch = () => { throw new Error("must not fetch"); };
    const res = response(); await (await handler())({ query: {} }, res);
    assert.equal(res.statusCode, 401); assert.equal(res.body.code, "dashboard_key");
  });
  await t.test("missing refresh token offers setup", async () => {
    delete process.env.SPOTIFY_REFRESH_TOKEN;
    const res = response(); await (await handler())(request, res);
    assert.equal(res.body.code, "spotify_setup");
    process.env.SPOTIFY_REFRESH_TOKEN = "test-refresh";
  });
  await t.test("invalid refresh token offers reconnection without leaking credentials", async () => {
    global.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const res = response(); await (await handler())(request, res);
    assert.equal(res.statusCode, 502); assert.equal(res.body.code, "spotify_reconnect");
    assert.ok(!JSON.stringify(res.body).includes("test-refresh"));
  });
  await t.test("network errors return actionable JSON", async () => {
    global.fetch = async () => { throw new Error("network"); };
    const res = response(); await (await handler())(request, res);
    assert.equal(res.statusCode, 502); assert.equal(res.body.code, "spotify_unavailable");
  });
  await t.test("playing track is normalized and access token is cached", async () => {
    let refreshes = 0;
    global.fetch = async (url) => {
      if (url.includes("api/token")) { refreshes++; return Response.json({ access_token: "access", expires_in: 3600 }); }
      return Response.json({ is_playing: true, progress_ms: 1000, device: { name: "Laptop" },
        item: { type: "track", name: "Song", artists: [{ name: "Artist" }], duration_ms: 200000,
          album: { name: "Album", images: [{ url: "https://example.test/art.jpg" }] } } });
    };
    const run = await handler(); const res = response(); await run(request, res); await run(request, response());
    assert.equal(refreshes, 1); assert.equal(res.body.playing, true);
    assert.equal(res.body.title, "Song"); assert.equal(res.body.device, "Laptop");
  });
  await t.test("no active playback is a normal idle response", async () => {
    global.fetch = async (url) => url.includes("api/token")
      ? Response.json({ access_token: "access", expires_in: 3600 }) : new Response(null, { status: 204 });
    const res = response(); await (await handler())(request, res);
    assert.deepEqual(res.body, { playing: false });
  });
  await t.test("reconnect requires a dashboard key even with an existing token", () => {
    const denied = response(); login({ query: {} }, denied); assert.equal(denied.statusCode, 401);
    const res = response(); login(request, res);
    const url = new URL(res.redirectUrl);
    assert.equal(url.searchParams.get("redirect_uri"), process.env.SPOTIFY_REDIRECT_URI);
    assert.ok(url.searchParams.get("state")); assert.match(res.headers["Set-Cookie"], /HttpOnly; Secure; SameSite=Lax/);
  });
  await t.test("callback rejects forged state before contacting Spotify", async () => {
    global.fetch = () => { throw new Error("must not fetch"); };
    const res = response(); await callback({ query: { code: "bad", state: "forged" }, headers: { cookie: "spotify_state=forged" } }, res);
    assert.equal(res.statusCode, 400);
  });
  await t.test("authorized reconnect exchanges code and prevents caching token page", async () => {
    const start = response(); login(request, start);
    const state = new URL(start.redirectUrl).searchParams.get("state");
    global.fetch = async () => Response.json({ refresh_token: "new-test-refresh" });
    const res = response(); await callback({ query: { code: "approved", state }, headers: { cookie: `spotify_state=${state}` } }, res);
    assert.equal(res.statusCode, 200); assert.match(res.body, /new-test-refresh/);
    assert.equal(res.headers["Cache-Control"], "no-store");
  });
});

test("display shows connection errors, playback, paused state, and network failures", async () => {
  const source = readFileSync(new URL("../index.html", import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { body: { dataset: {}, classList: { toggle() {} } },
    getElementById(id) { if (!elements.has(id)) elements.set(id, { style: {} }); return elements.get(id); }, addEventListener() {} };
  let reply = Response.json({ code: "spotify_reconnect", error: "Reconnect Spotify" }, { status: 502 });
  const context = vm.createContext({ document, navigator: {}, location: { search: "?key=test-key" }, URLSearchParams,
    AbortController, setTimeout() {}, clearTimeout() {}, setInterval() {},
    fetch: async (url) => url.startsWith("/api/") ? reply.clone() : Response.json(null) });
  vm.runInContext(source.replace(/  \/\/ ---------- Start ----------[\s\S]*/, ""), context);
  await vm.runInContext("loadMusic()", context);
  assert.equal(elements.get("spotifyMessage").textContent, "Reconnect Spotify");
  assert.equal(elements.get("spotifyConnect").hidden, false);
  reply = Response.json({ playing: true, title: "Song", artist: "Artist", art: "", progress: 0, duration: 2000 });
  await vm.runInContext("loadMusic()", context);
  assert.equal(document.body.dataset.view, "music"); assert.equal(elements.get("title").textContent, "Song");
  elements.get("artBg").style.backgroundImage = 'url("previous-photo.jpg")';
  await vm.runInContext("loadMusic()", context);
  assert.equal(elements.get("artBg").style.backgroundImage, "none");
  reply = Response.json({ playing: false, title: "Song" });
  await vm.runInContext("loadMusic()", context);
  // A normal idle/paused state is silent so the photo album stays uncluttered.
  assert.equal(elements.get("spotifyStatus").hidden, true);
  assert.equal(elements.get("spotifyMessage").textContent, "");
  assert.equal(document.body.dataset.view, "photos");
  reply = new Response("not JSON", { status: 502 });
  await vm.runInContext("loadMusic()", context);
  assert.match(elements.get("spotifyMessage").textContent, /Cannot reach Spotify/);
});
