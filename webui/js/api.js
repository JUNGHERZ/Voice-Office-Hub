/*
 * Schlanker fetch-Wrapper für die Management-API (gleicher Origin, Cookie-Session).
 * Liefert geparste JSON-Daten und wirft bei Fehlern. 401 wird gesondert behandelt,
 * damit die App ins Login-Gate zurückfallen kann.
 */

/** Wird ausgelöst, wenn die API 401 liefert (Session abgelaufen/fehlt). */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** Wird bei sonstigen HTTP-Fehlern (>=400) geworfen. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(method, path, body) {
  const opts = {
    method,
    headers: {},
    credentials: "same-origin",
  };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new ApiError(0, `Netzwerkfehler: ${e.message}`);
  }

  if (res.status === 401) throw new UnauthorizedError();

  // 204 / leerer Body
  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (!res.ok) {
    const msg = data && (data.message || data.error) ? data.message || data.error : null;
    throw new ApiError(res.status, msg);
  }
  return data;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  // Auth
  me: () => request("GET", "/api/me"),
  login: (password) => request("POST", "/api/login", { password }),
  logout: () => request("POST", "/api/logout"),

  // Agents
  listAgents: () => request("GET", "/api/agents"),
  getAgent: (id) => request("GET", `/api/agents/${id}`),
  createAgent: (data) => request("POST", "/api/agents", data),
  updateAgent: (id, data) => request("PATCH", `/api/agents/${id}`, data),
  deleteAgent: (id) => request("DELETE", `/api/agents/${id}`),

  // Tools (eingebaute, read-only)
  listTools: () => request("GET", "/api/tools"),

  // Requests (Anrufe)
  listRequests: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    const q = qs.toString();
    return request("GET", `/api/requests${q ? `?${q}` : ""}`);
  },
  getRequest: (id) => request("GET", `/api/requests/${id}`),
  recordingUrl: (id) => `/api/requests/${id}/recording`,
};
