import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { seal, unseal, startAuthorization, validateState, stateCookie, SCOPE, createCalendarService } from "../lib/google-calendar.js";
import { createHandler as calendarHandler } from "../api/google-calendar.js";
import { createHandler as callbackHandler } from "../api/google-callback.js";
import { createHandler as remindersHandler } from "../api/reminders.js";

const response = () => ({ statusCode: 200, headers: {},
  setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; },
  json(body) { this.body = body; }, send(body) { this.body = body; },
  redirect(code, url) { this.statusCode = code; this.url = url; } });
const request = (method = "GET") => ({ method, query: { key: "display" }, headers: { "x-admin-key": "admin" } });

test("Google Calendar connection and reminder sync", async (t) => {
  const original = { ...process.env };
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_CALENDAR_SECRET: "12".repeat(32),
    GOOGLE_REDIRECT_URI: "https://display.test/api/google-callback", BLOB_READ_WRITE_TOKEN: "blob", DASH_KEY: "display", ADMIN_KEY: "admin" });
  t.after(() => { process.env = original; });

  await t.test("ciphertext conceals tokens and detects tampering", () => {
    const encoded = seal({ refreshToken: "private-refresh" });
    assert.ok(!encoded.includes("private-refresh"));
    assert.equal(unseal(encoded).refreshToken, "private-refresh");
    const parts = encoded.split("."); parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    assert.throws(() => unseal(parts.join(".")));
  });

  await t.test("OAuth requires admin key and binds state, browser, expiry, and PKCE", async () => {
    const handler = calendarHandler({});
    const blocked = response(); await handler({ ...request("POST"), headers: { "x-admin-key": "display" } }, blocked);
    assert.equal(blocked.statusCode, 401);
    const res = response(); await handler(request("POST"), res);
    const url = new URL(res.body.url);
    assert.equal(url.searchParams.get("scope"), SCOPE);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(res.headers["Set-Cookie"], /HttpOnly; Secure; SameSite=Lax; Path=\//);
    const req = { query: { state: url.searchParams.get("state") }, headers: { cookie: res.headers["Set-Cookie"] } };
    assert.ok(validateState(req).verifier);
    assert.equal(validateState({ ...req, headers: {} }), null);
    assert.equal(validateState({ ...req, query: { state: "forged" } }), null);
    req.headers.cookie = stateCookie(seal({ state: req.query.state, verifier: "v", issued: Date.now() - 601000 }));
    assert.equal(validateState(req), null);
  });

  await t.test("callback rejects forged state, handles cancellation, and saves only approved connections", async () => {
    let saved = 0;
    const handler = callbackHandler({ async connect(code, verifier) { assert.equal(code, "approved"); assert.ok(verifier); saved++; } });
    let res = response(); await handler({ ...request(), query: { state: "forged", code: "approved" } }, res);
    assert.match(res.url, /expired/); assert.equal(saved, 0);
    const auth = startAuthorization();
    const req = { ...request(), query: { state: new URL(auth.url).searchParams.get("state"), error: "access_denied" }, headers: { cookie: auth.cookie } };
    res = response(); await handler(req, res); assert.match(res.url, /cancelled/);
    req.query = { state: req.query.state, code: "approved" };
    res = response(); await handler(req, res);
    assert.equal(saved, 1); assert.equal(res.url, "/admin.html?google=connected");
    assert.match(res.headers["Set-Cookie"], /Max-Age=0/); assert.equal(res.headers["Cache-Control"], "no-store");
  });

  await t.test("persistent encrypted connection syncs edits, recurrence instances, all-day dates, deletions and revocation", async () => {
    const blobs = new Map(); let items = []; let revoked = false; let limited = false;
    const storage = {
      async list() { return { blobs: [...blobs.keys()].map((pathname) => ({ pathname, url: `https://blob.test/${pathname}` })) }; },
      async put(path, text) { assert.ok(!text.includes("refresh-private")); blobs.set(path, text); },
      async del(urls) { for (const url of urls) blobs.delete(url.replace("https://blob.test/", "")); },
    };
    const network = async (url, options) => {
      if (url.startsWith("https://blob.test/")) return new Response(blobs.get(url.replace("https://blob.test/", "")));
      if (url.endsWith("/token")) {
        if (revoked) return Response.json({ error: "invalid_grant", secret: "must-not-leak" }, { status: 400 });
        return Response.json({ access_token: "access-private", refresh_token: "refresh-private", scope: SCOPE });
      }
      const query = new URL(url).searchParams;
      assert.equal(query.get("singleEvents"), "true"); assert.equal(query.get("orderBy"), "startTime");
      assert.equal(query.get("maxResults"), "100"); assert.ok(query.get("timeMin")); assert.ok(query.get("timeMax"));
      assert.equal(options.headers.Authorization, "Bearer access-private");
      return Response.json({ items, ...(limited ? { nextPageToken: "next" } : {}) });
    };
    let service = createCalendarService(storage, network);
    assert.equal((await service.feed()).status, "disconnected");
    await service.connect("code", "verifier");
    // A new server instance must be able to load the saved connection.
    service = createCalendarService(storage, network);
    items = [
      { id: "all-day", summary: "Birthday", start: { date: "2026-10-03" }, end: { date: "2026-10-04" } },
      { id: "recurring_1", summary: "First", start: { dateTime: "2026-10-03T09:00:00-04:00" } },
      { id: "recurring_2", summary: "Second", start: { dateTime: "2026-10-04T09:00:00-04:00" } },
      { id: "cancelled", status: "cancelled", start: { date: "2026-10-03" } },
      { id: "declined", start: { date: "2026-10-03" }, attendees: [{ self: true, responseStatus: "declined" }] },
    ];
    const first = await service.feed(); assert.equal(first.reminders.length, 3);
    assert.equal(first.reminders[0].due, "2026-10-03"); assert.equal(first.reminders[0].allDay, true);
    assert.ok(!JSON.stringify(first).includes("private"));
    items = [{ ...items[1], summary: "Changed on phone" }]; limited = true;
    const changed = await service.feed(); assert.equal(changed.reminders.length, 1);
    assert.equal(changed.reminders[0].text, "Changed on phone"); assert.equal(changed.limited, true);
    items = []; assert.equal((await service.feed()).reminders.length, 0);
    revoked = true;
    await assert.rejects(service.feed(), (error) => error.code === "google_reconnect" && !error.message.includes("must-not-leak"));
    await service.disconnect(); assert.equal(blobs.size, 0);
    assert.equal((await service.feed()).status, "disconnected");
  });

  await t.test("reminder API protects events, preserves manual reminders during outages, and never saves imported events", async () => {
    let manual = [{ id: "r_1", text: "Manual" }]; let unavailable = false; let calls = 0;
    const handler = remindersHandler({ read: async () => [...manual], write: async (items) => { manual = items; }, calendarService: {
      async feed() { calls++; if (unavailable) throw new Error("secret-provider-error"); return { status: "connected", reminders: [{ id: "g_1", source: "google", text: "Event" }] }; },
    } });
    let res = response(); await handler({ ...request(), query: {} }, res); assert.equal(res.statusCode, 401); assert.equal(calls, 0);
    res = response(); await handler(request(), res); assert.equal(res.body.reminders.length, 2);
    res = response(); await handler({ ...request("POST"), body: { text: "New manual" } }, res);
    assert.equal(manual.length, 2); assert.ok(manual.every((item) => !item.id.startsWith("g_")));
    res = response(); await handler({ ...request("DELETE"), query: { id: "g_1" } }, res); assert.equal(res.statusCode, 400);
    unavailable = true; res = response(); await handler(request(), res);
    assert.equal(res.body.reminders.length, 2); assert.equal(res.body.google.status, "error");
    assert.ok(!JSON.stringify(res.body).includes("secret-provider-error"));
    delete process.env.DASH_KEY;
    res = response(); await handler({ ...request(), query: {} }, res); assert.equal(res.statusCode, 401);
    process.env.DASH_KEY = "display";
  });

  await t.test("setup and provider errors are actionable without exposing secrets", async () => {
    const handler = calendarHandler({ async feed() { throw new Error("token-secret"); } });
    let res = response(); await handler(request(), res); assert.equal(res.statusCode, 502); assert.ok(!res.body.error.includes("token-secret"));
    delete process.env.GOOGLE_CLIENT_ID;
    res = response(); await handler(request(), res); assert.equal(res.body.status, "setup"); assert.ok(res.body.missing.includes("GOOGLE_CLIENT_ID"));
    res = response(); await handler(request("POST"), res); assert.equal(res.statusCode, 503);
    process.env.GOOGLE_CLIENT_ID = "client";
  });
});

test("admin and display render calendar dates, safe text and read-only event controls", async () => {
  for (const file of ["admin.html", "index.html"]) {
    const elements = new Map();
    const document = { body: { dataset: {}, classList: { toggle() {} } }, addEventListener() {},
      getElementById(id) { if (!elements.has(id)) elements.set(id, { style: {}, addEventListener() {} }); return elements.get(id); } };
    const context = vm.createContext({ document, navigator: {}, location: { search: "", origin: "https://display.test" }, URLSearchParams,
      sessionStorage: { getItem() { return ""; } }, setTimeout() {}, setInterval() {}, AbortController });
    let script = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
    if (file === "index.html") script = script.replace(/  \/\/ ---------- Start ----------[\s\S]*/, "");
    vm.runInContext(script, context);
    const due = vm.runInContext('new Date(dueTime("2026-10-03")).getDate()', context); assert.equal(due, 3);
    const events = [{ id: "g_1", text: "<script>bad</script>", source: "google", due: "2026-10-03" }, { id: "r_1", text: "Manual" }];
    if (file === "admin.html") {
      vm.runInContext(`renderReminders(${JSON.stringify(events)})`, context);
      const html = elements.get("rBody").innerHTML;
      assert.match(html, /Google Calendar/); assert.ok(!html.includes('data-del="g_1"')); assert.ok(html.includes('data-del="r_1"'));
      assert.ok(!html.includes("<script>"));
    } else {
      vm.runInContext(`reminders = ${JSON.stringify(events)}; renderReminders()`, context);
      assert.ok(!elements.get("reminderList").innerHTML.includes("<script>"));
      vm.runInContext('reminders = []; reminderError = "Reconnect Google Calendar"; renderReminders()', context);
      assert.equal(elements.get("reminders").hidden, false);
      assert.equal(elements.get("reminderStatus").textContent, "Reconnect Google Calendar");
    }
  }
});
