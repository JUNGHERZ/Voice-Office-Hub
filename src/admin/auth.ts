/**
 * Auth für Admin-UI + Management-API.
 *  - UI: Login per ADMIN_PASSWORD → signiertes Session-Cookie.
 *  - API (extern): Header `x-api-key` == ADMIN_API_KEY.
 * Beide Wege erfüllen `requireAuth` (preHandler auf den /api-Routen).
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { config } from "../config.js";

export const SESSION_COOKIE = "vh_session";
const SESSION_VALUE = "ok";
const SESSION_MAX_AGE = 60 * 60 * 12; // 12h

export function passwordValid(pw: unknown): boolean {
  return typeof pw === "string" && config.admin.password.length > 0 && pw === config.admin.password;
}

export function setSession(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, SESSION_VALUE, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    signed: true,
    maxAge: SESSION_MAX_AGE,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Trägt die Anfrage einen gültigen Management-API-Key?
 *
 * Eigene Funktion, weil es außerhalb von `requireAuth` einen zweiten Leser gibt: Der
 * öffentliche Widget-Session-Endpoint bleibt öffentlich, behandelt einen authentifizierten
 * Aufrufer aber als Vermittler und nicht als Besucher (siehe routes/widget.ts). Zwei
 * Vergleichspfade für dasselbe Geheimnis wären eine Einladung, einen davon zu vergessen.
 */
export function hasValidApiKey(req: FastifyRequest): boolean {
  return !!config.admin.apiKey && req.headers["x-api-key"] === config.admin.apiKey;
}

/** preHandler: lässt valides Session-Cookie ODER gültigen API-Key durch, sonst 401. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (hasValidApiKey(req)) return;

  const raw = req.cookies?.[SESSION_COOKIE];
  if (raw) {
    const r = req.unsignCookie(raw);
    if (r.valid && r.value === SESSION_VALUE) return;
  }
  await reply.code(401).send({ error: "unauthorized" });
}
