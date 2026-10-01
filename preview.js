const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let width = 1920;
let height = 1080;

function fit() {
  const availableWidth = Math.max(1, $("stage").clientWidth - 4);
  const availableHeight = Math.max(1, $("stage").clientHeight - 4);
  if ($("screen").value === "fit") {
    width = Math.round(availableWidth);
    height = Math.round(availableHeight);
  }
  const scale = Math.min(1, availableWidth / width, availableHeight / height);
  $("display").style.width = `${width}px`;
  $("display").style.height = `${height}px`;
  $("display").style.transform = `scale(${scale})`;
  $("frame").style.width = `${width * scale}px`;
  $("frame").style.height = `${height * scale}px`;
  $("width").value = width;
  $("height").value = height;
  $("readout").textContent = `${width} × ${height} · ${Math.round(scale * 100)}% scale`;
}

function loadDisplay() {
  const live = $("content").value === "live";
  const query = new URLSearchParams();
  if (params.has("key") && live) query.set("key", params.get("key"));
  if (!live) {
    query.set("preview", "1");
    query.set("demo", "1");
    query.set("fx", $("effect").value);
    query.set("view", $("content").value);
  }
  $("effect").disabled = live;
  $("modeNote").textContent = live
    ? "Live weather and connected content. Open this page on your deployment with ?key=YOUR_DASH_KEY. Local preview serves samples only."
    : "Sample content. Changes here only affect this preview. Your desk displays keep following live weather.";
  const url = `/?${query}`;
  $("display").src = url;
  $("openDisplay").href = url;
}

$("screen").addEventListener("change", () => {
  const value = $("screen").value;
  if (value.includes("x")) [width, height] = value.split("x").map(Number);
  fit();
});
for (const name of ["width", "height"]) {
  $(name).addEventListener("change", () => {
    if (!$(name).reportValidity() || !$(name).value) { fit(); return; }
    width = Number($("width").value);
    height = Number($("height").value);
    $("screen").value = "custom";
    fit();
  });
}
$("rotate").addEventListener("click", () => {
  [width, height] = [height, width];
  $("screen").value = "custom";
  fit();
});
$("effect").addEventListener("change", loadDisplay);
$("content").addEventListener("change", loadDisplay);
$("fullscreen").addEventListener("click", async () => {
  // Fullscreen the document, not the scaled iframe, so the dashboard reflows.
  try { await $("display").contentDocument.documentElement.requestFullscreen(); }
  catch { $("modeNote").textContent = "Fullscreen is unavailable. Use Open full size to preview in a new tab."; }
});
const motion = matchMedia("(prefers-reduced-motion: reduce)");
function motionNote() {
  $("motionNote").textContent = motion.matches ? "Reduced motion is on. Weather effects are still." : "Effects pause when this tab is hidden.";
}
motion.addEventListener("change", motionNote);
motionNote();
new ResizeObserver(fit).observe($("stage"));
loadDisplay();
fit();
