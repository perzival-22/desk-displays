import { calendar, setupMissing, stateCookie, validateState } from "../lib/google-calendar.js";

export function createHandler(service = calendar) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET") return res.status(405).send("Method not allowed.");
    const state = validateState(req);
    res.setHeader("Set-Cookie", stateCookie("", 0));
    if (!state) return res.redirect(303, "/admin.html?google=expired");
    if (req.query.error || typeof req.query.code !== "string") return res.redirect(303, "/admin.html?google=cancelled");
    if (setupMissing().length) return res.redirect(303, "/admin.html?google=setup");
    try {
      await service.connect(req.query.code, state.verifier);
      return res.redirect(303, "/admin.html?google=connected");
    } catch {
      return res.redirect(303, "/admin.html?google=failed");
    }
  };
}

export default createHandler();
