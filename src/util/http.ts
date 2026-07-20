/**
 * HTTP-Hilfen für ausgehende Tool-Aufrufe: hartes Timeout via AbortSignal und
 * `${ENV:NAME}`-Platzhalter, damit Secrets (API-Keys in Headern/URLs) in der
 * Umgebung bleiben statt in der Datenbank.
 */
import { logger } from "./logger.js";

const log = logger.child({ mod: "http" });

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 8000, ...rest } = init;
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Ersetzt `${ENV:NAME}` durch process.env.NAME. Unauflösbare Platzhalter werden zu ""
 * plus Warn-Log — der Request geht trotzdem raus; ein 401 vom Endpoint ist sichtbarer
 * als ein stiller Abbruch vor dem Versand.
 */
export function substituteEnvPlaceholders(value: string): string {
  return value.replace(/\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      log.warn("ENV-Platzhalter nicht auflösbar", { name });
      return "";
    }
    return v;
  });
}
