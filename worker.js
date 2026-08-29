const NETWORK_SERVERS = [
  {
    id: "zm",
    name: "CS 1.6 ZM & LVL SYSTEM",
    address: "5.141.89.34:5006",
    fallbackMap: "unknown",
    fallbackMode: "Zombie Mod",
  },
  {
    id: "ze",
    name: "CS 1.6 ZE & NEMESIS MODE",
    address: "5.141.89.34:5005",
    fallbackMap: "unknown",
    fallbackMode: "Zombie Escape",
  },
  {
    id: "dm",
    name: "CS 1.6 DEATHMATCH",
    address: "5.141.89.34:5002",
    fallbackMap: "unknown",
    fallbackMode: "Deathmatch",
  },
  {
    id: "jail",
    name: "JAIL | Побег из Ада 12+",
    address: "5.141.89.34:5003",
    fallbackMap: "unknown",
    fallbackMode: "JailBreak",
  },
];

const DEFAULT_ALLOWED_ORIGINS = "https://avalon-kontra.github.io";
const DEFAULT_PUBLIC_SITE_URL = "https://avalon-kontra.github.io/avalon/";

let schemaReady = null;

function getDb(env) {
  const db = env.STATUS_DB || env.DB || env.KONTRA_STATUS;
  if (!db) throw new Error("d1_unavailable");
  return db;
}

async function ensureSchema(env) {
  if (schemaReady) return schemaReady;
  const db = getDb(env);
  const statements = [
    `CREATE TABLE IF NOT EXISTS server_status (
      server_id TEXT PRIMARY KEY NOT NULL,
      updated_at INTEGER NOT NULL,
      online INTEGER NOT NULL DEFAULT 0,
      max_players INTEGER NOT NULL DEFAULT 16,
      map_name TEXT NOT NULL DEFAULT 'unknown',
      mode TEXT NOT NULL DEFAULT 'Unknown',
      zombies INTEGER NOT NULL DEFAULT 0,
      survivors INTEGER NOT NULL DEFAULT 0,
      room_state INTEGER NOT NULL DEFAULT 0,
      players_json TEXT NOT NULL DEFAULT '[]'
    )`,
  ];
  schemaReady = db
    .batch(statements.map((sql) => db.prepare(sql)))
    .then(() => undefined)
    .catch((error) => {
      schemaReady = null;
      throw error;
    });
  return schemaReady;
}

function boundedInt(value, min, max, fallback = 0) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function boundedText(value, maxLength, fallback = "") {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeServerId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "zm" || normalized === "5006") return "zm";
  if (normalized === "ze" || normalized === "5005") return "ze";
  if (normalized === "dm" || normalized === "5002") return "dm";
  if (normalized === "jail" || normalized === "5003") return "jail";
  return null;
}

function serverSecret(env, serverId) {
  if (serverId === "zm") return String(env.KONTRA_TOKEN_5006 || "");
  if (serverId === "ze") return String(env.KONTRA_TOKEN_5005 || "");
  if (serverId === "dm") return String(env.KONTRA_TOKEN_5002 || "");
  if (serverId === "jail") return String(env.KONTRA_TOKEN_5003 || "");
  return "";
}

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function verifyServerRequest(request, env, serverId) {
  const expected = serverSecret(env, serverId);
  const supplied = bearerToken(request);
  return expected.length >= 32 && constantTimeEqual(supplied, expected);
}

function allowedOriginSet(env) {
  const origins = new Set(
    String(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
      .split(",")
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
  try {
    const publicSiteUrl = new URL(
      String(env.PUBLIC_SITE_URL || DEFAULT_PUBLIC_SITE_URL),
    );
    origins.add(publicSiteUrl.origin);
  } catch {}
  return origins;
}

function isOriginAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const origins = allowedOriginSet(env);
  return origins.has("*") || origins.has(origin.replace(/\/+$/, ""));
}

function responseHeaders(request, env) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  const origin = request.headers.get("origin");
  if (origin && isOriginAllowed(request, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Max-Age", "86400");
    headers.append("Vary", "Origin");
  }
  return headers;
}

function jsonResponse(request, env, payload, status = 200) {
  const headers = responseHeaders(request, env);
  return new Response(JSON.stringify(payload), { status, headers });
}

function jsonOk(request, env, payload = {}, status = 200) {
  return jsonResponse(request, env, { ok: true, ...payload }, status);
}

function jsonError(request, env, error, status) {
  return jsonResponse(request, env, { ok: false, error }, status);
}

async function readJson(request) {
  const declaredSize = Number(request.headers.get("content-length") || 0);
  if (declaredSize > 128 * 1024) throw new Error("payload_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 128 * 1024) {
    throw new Error("payload_too_large");
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("invalid_json");
  }
}

function sanitizePlayers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).map((player, index) => {
    const item = player && typeof player === "object" ? player : {};
    return {
      slot: boundedInt(item.slot, 1, 16, index + 1),
      name: boundedText(item.name, 40, `Player ${index + 1}`),
      team: String(item.team || "").toUpperCase() === "T" ? "T" : "CT",
      alive: item.alive === true,
      hp: boundedInt(item.hp, 0, 65_535),
      armor: boundedInt(item.armor, 0, 65_535),
      score: boundedInt(item.score, 0, 65_535),
      deaths: boundedInt(item.deaths, 0, 65_535),
    };
  });
}

function parsePlayers(value) {
  try {
    return sanitizePlayers(JSON.parse(String(value || "[]")));
  } catch {
    return [];
  }
}

async function getNetwork(request, env) {
  const db = getDb(env);
  const statusResult = await db.prepare("SELECT * FROM server_status").all();

  const statusById = new Map(
    (statusResult.results || []).map((row) => [String(row.server_id), row]),
  );
  const now = Date.now();

  const servers = NETWORK_SERVERS.map((definition) => {
    const row = statusById.get(definition.id);
    const updatedAt = boundedInt(row?.updated_at, 0, Number.MAX_SAFE_INTEGER);
    const serverOnline = updatedAt > 0 && now - updatedAt <= 60_000;
    const players = serverOnline ? parsePlayers(row?.players_json) : [];
    return {
      id: definition.id,
      name: definition.name,
      address: definition.address,
      map: serverOnline
        ? boundedText(row?.map_name, 80, definition.fallbackMap)
        : definition.fallbackMap,
      mode: serverOnline
        ? boundedText(row?.mode, 80, definition.fallbackMode)
        : definition.fallbackMode,
      online: serverOnline ? boundedInt(row?.online, 0, 16) : 0,
      maxPlayers: 16,
      serverOnline,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      zombies: serverOnline ? boundedInt(row?.zombies, 0, 16) : 0,
      survivors: serverOnline ? boundedInt(row?.survivors, 0, 16) : 0,
      roomState: serverOnline ? boundedInt(row?.room_state, 0, 20) : 0,
      players,
    };
  });

  return jsonOk(request, env, { servers });
}

async function postStatusUpdate(request, env) {
  const payload = await readJson(request);
  const serverId = normalizeServerId(payload.serverId);
  if (!serverId) return jsonError(request, env, "invalid_server", 400);
  if (!verifyServerRequest(request, env, serverId)) {
    return jsonError(request, env, "unauthorized", 401);
  }

  const db = getDb(env);
  const now = Date.now();
  const players = sanitizePlayers(payload.players);
  const online = Math.min(
    16,
    Math.max(players.length, boundedInt(payload.online, 0, 16)),
  );
  const mapName = boundedText(payload.map, 80, "unknown");
  const mode = boundedText(
    payload.mode,
    80,
    serverId === "zm" ? "Zombie Mod" : "Zombie Escape",
  );

  await db
    .prepare(
      `INSERT INTO server_status
        (server_id, updated_at, online, max_players, map_name, mode,
         zombies, survivors, room_state, players_json)
       VALUES (?, ?, ?, 16, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         online = excluded.online,
         max_players = 16,
         map_name = excluded.map_name,
         mode = excluded.mode,
         zombies = excluded.zombies,
         survivors = excluded.survivors,
         room_state = excluded.room_state,
         players_json = excluded.players_json`,
    )
    .bind(
      serverId,
      now,
      online,
      mapName,
      mode,
      boundedInt(payload.zombies, 0, 16),
      boundedInt(payload.survivors, 0, 16),
      boundedInt(payload.roomState, 0, 20),
      JSON.stringify(players),
    )
    .run();

  return jsonOk(request, env, { serverId, updatedAt: now });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      if (!isOriginAllowed(request, env)) {
        return jsonError(request, env, "origin_not_allowed", 403);
      }
      return new Response(null, {
        status: 204,
        headers: responseHeaders(request, env),
      });
    }
    if (!isOriginAllowed(request, env)) {
      return jsonError(request, env, "origin_not_allowed", 403);
    }

    try {
      await ensureSchema(env);
      const url = new URL(request.url);
      let path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/api") path = "/";
      if (path.startsWith("/api/")) path = path.slice(4);

      if (request.method === "GET" && path === "/network") {
        return getNetwork(request, env);
      }
      if (request.method === "POST" && path === "/update") {
        return postStatusUpdate(request, env);
      }
      return jsonError(request, env, "not_found", 404);
    } catch (error) {
      console.error("KONTRA Worker error", error);
      const message = error instanceof Error ? error.message : "";
      if (message === "payload_too_large") {
        return jsonError(request, env, "payload_too_large", 413);
      }
      if (message === "invalid_json") {
        return jsonError(request, env, "invalid_payload", 400);
      }
      if (message === "d1_unavailable") {
        return jsonError(request, env, "database_unavailable", 503);
      }
      return jsonError(request, env, "internal_error", 500);
    }
  },
};