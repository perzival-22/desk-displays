import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/  \/\/ ---------- Start ----------[\s\S]*/, "");

function display(search = "", reduced = false) {
  const elements = new Map();
  const listeners = {};
  const drawing = new Proxy({}, { get: (_, key) => key === "createRadialGradient"
    ? () => ({ addColorStop() {} }) : () => {} });
  let nextFrame;
  const document = { hidden: false, body: { dataset: {}, classList: { toggle() {} } },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, dataset: {}, getContext: () => drawing });
      return elements.get(id);
    }, addEventListener(name, cb) { (listeners[name] ||= []).push(cb); } };
  const context = vm.createContext({ document, navigator: {}, location: { search }, URLSearchParams,
    AbortController, Date, setTimeout() {}, clearTimeout() {}, setInterval() {},
    innerWidth: 1024, innerHeight: 600, window: { devicePixelRatio: 1, addEventListener() {} },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame(cb) { nextFrame = cb; return 1; }, cancelAnimationFrame() { nextFrame = null; },
    fetch: async () => Response.json(null) });
  vm.runInContext(source, context);
  return { context, elements, document, listeners, run: (js) => vm.runInContext(js, context),
    frame: () => nextFrame && nextFrame(1000), animating: () => !!nextFrame };
}

function forecast(code, isDay = 1) {
  const now = Math.floor(Date.now() / 1000);
  return { current: { temperature_2m: 68, weather_code: code, is_day: isDay },
    daily: { temperature_2m_max: [72], temperature_2m_min: [52], sunrise: [now - 3600], sunset: [now + 3600] } };
}

test("live conditions select labels and draw effects without a URL override", async () => {
  const d = display("?fx=snow"); // Old kiosk bookmarks must return to automatic weather.
  for (const [code, day, label, effect] of [
    [0, 1, "Sunny", "sun"], [1, 1, "Mostly sunny", "sun"],
    [0, 0, "Clear night", "stars"], [1, 0, "Mostly clear", "stars"],
    [2, 1, "Partly cloudy", "partly"], [2, 0, "Partly cloudy", "partly"],
    [3, 1, "Cloudy", "clouds"], [3, 0, "Cloudy", "clouds"],
    [45, 1, "Fog", "mist"], [61, 1, "Light rain", "rain"],
    [65, 1, "Heavy rain", "rain"], [75, 1, "Heavy snow", "snow"],
    [95, 1, "Thunderstorms", "storm"], [999, 1, "Conditions unavailable", "none"],
  ]) {
    d.context.fetch = async (url) => {
      const params = new URL(url).searchParams;
      assert.match(params.get("current"), /is_day/);
      assert.equal(params.get("timeformat"), "unixtime");
      return Response.json(forecast(code, day));
    };
    await d.run("loadWeather()");
    assert.equal(d.elements.get("cond").textContent, label);
    assert.equal(d.elements.get("weatherfx").dataset.effect, effect);
    assert.equal(d.elements.get("weatherStatus").hidden, true);
    assert.equal(d.animating(), effect !== "none");
    d.frame(); // Exercise each canvas drawing branch, including clouds.
  }
});

test("weather failures retain readings, expire effects, and recover", async () => {
  const d = display();
  await d.run("loadWeather()");
  assert.match(d.elements.get("weatherStatus").textContent, /unavailable/);
  d.context.fetch = async () => Response.json(forecast(3));
  await d.run("loadWeather()");
  d.context.fetch = async () => { throw new Error("offline"); };
  await d.run("loadWeather()");
  assert.equal(d.elements.get("cond").textContent, "Cloudy");
  assert.match(d.elements.get("weatherStatus").textContent, /delayed/);
  d.run("weatherAt = Date.now() - 31 * 60 * 1000; render()");
  assert.equal(d.elements.get("weatherfx").dataset.effect, "none");
  d.context.fetch = async () => Response.json(forecast(0));
  await d.run("loadWeather()");
  assert.equal(d.elements.get("weatherStatus").hidden, true);
  assert.equal(d.elements.get("weatherfx").dataset.effect, "sun");
});

test("effect preview is explicit, and reduced motion and hidden tabs stop animation", () => {
  const preview = display("?preview=1&fx=rain");
  preview.run("WeatherFX.set(3, 'day', false)");
  assert.equal(preview.elements.get("weatherfx").dataset.effect, "rain");
  const d = display();
  d.run("WeatherFX.set(3, 'day', false)");
  assert.equal(d.animating(), true);
  d.document.hidden = true;
  d.listeners.visibilitychange.forEach((cb) => cb());
  assert.equal(d.animating(), false);
  d.document.hidden = false;
  d.listeners.visibilitychange.forEach((cb) => cb());
  assert.equal(d.animating(), true);
  const reduced = display("", true);
  reduced.run("WeatherFX.set(3, 'day', false)");
  assert.equal(reduced.animating(), false);
});

test("sample preview isolates connected data and requires explicit preview mode", async () => {
  const demo = display("?preview=1&demo=1");
  let requests = 0;
  demo.context.fetch = async () => { requests++; throw new Error("Sample preview must stay offline"); };
  await demo.run("Promise.all([loadWeather(), loadMusic(), loadPhotos(), loadReminders()])");
  assert.equal(requests, 0);
  assert.equal(demo.run("DEMO"), true);
  assert.equal(display("?demo=1").run("DEMO"), false);
  assert.equal(display("?preview=1").run("DEMO"), false);
});
