// ============================================================
// Cloudflare Worker: kontra-status
// Принимает статус от Lua-серверов и отдаёт JSON для GitHub Pages
// ============================================================

const UPDATE_TOKEN = "a3f9c2e8b74d1f6e5a0c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7";
const OFFLINE_TIMEOUT_SECONDS = 60;

const SERVERS = {
  "zm": 16,
  "ze": 16,
  "dm": 16,
  "jail": 16
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === "/api/update") {
      return handleUpdate(request, env);
    }
    
    if (url.pathname === "/api/status") {
      return handleStatus(env);
    }
    
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }
    
    return corsResponse(new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    }));
  }
};

async function handleUpdate(request, env) {
  if (request.method !== "POST") {
    return corsResponse(new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    }));
  }
  
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  
  if (token !== UPDATE_TOKEN) {
    return corsResponse(new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    }));
  }
  
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return corsResponse(new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    }));
  }
  
  const serverId = payload.serverId;
  
  if (!serverId || !SERVERS[serverId]) {
    return corsResponse(new Response(JSON.stringify({ error: "Invalid serverId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    }));
  }
  
  const online = Math.max(0, Math.min(parseInt(payload.online) || 0, SERVERS[serverId]));
  const maxPlayers = SERVERS[serverId];
  const map = (payload.map && payload.map.toString().substring(0, 64)) || "unknown";
  const mode = (payload.mode && payload.mode.toString().substring(0, 64)) || "unknown";
  const zombies = parseInt(payload.zombies) || 0;
  const survivors = parseInt(payload.survivors) || 0;
  const roomState = parseInt(payload.roomState) || 0;
  
  const players = Array.isArray(payload.players) ? payload.players.slice(0, maxPlayers).map(p => ({
    slot: parseInt(p.slot) || 0,
    name: (p.name && p.name.toString().substring(0, 40)) || "Player",
    team: (p.team === "T" || p.team === "CT") ? p.team : "UNKNOWN",
    alive: p.alive === true,
    hp: parseInt(p.hp) || 0,
    armor: parseInt(p.armor) || 0,
    score: parseInt(p.score) || 0,
    deaths: parseInt(p.deaths) || 0,
    bot: p.bot === true
  })) : [];
  
  const timestamp = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({
    online,
    maxPlayers,
    map,
    mode,
    zombies,
    survivors,
    roomState,
    players,
    timestamp
  });
  
  try {
    await env.KONTRA_STATUS.put(serverId, data, {
      expirationTtl: 300
    });
    
    return corsResponse(new Response(JSON.stringify({ 
      ok: true, 
      serverId, 
      online, 
      maxPlayers,
      timestamp 
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
  } catch (e) {
    return corsResponse(new Response(JSON.stringify({ error: "Database error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    }));
  }
}

async function handleStatus(env) {
  const now = Math.floor(Date.now() / 1000);
  const result = {};
  
  for (const [serverId, maxPlayers] of Object.entries(SERVERS)) {
    try {
      const raw = await env.KONTRA_STATUS.get(serverId);
      
      if (!raw) {
        result[serverId] = {
          serverId,
          online: 0,
          maxPlayers,
          map: "unknown",
          mode: "unknown",
          zombies: 0,
          survivors: 0,
          roomState: 0,
          players: [],
          timestamp: 0,
          offline: true
        };
        continue;
      }
      
      const data = JSON.parse(raw);
      
      if (now - data.timestamp > OFFLINE_TIMEOUT_SECONDS) {
        result[serverId] = {
          serverId,
          online: 0,
          maxPlayers,
          map: "unknown",
          mode: "unknown",
          zombies: 0,
          survivors: 0,
          roomState: 0,
          players: [],
          timestamp: data.timestamp,
          offline: true
        };
      } else {
        result[serverId] = {
          ...data,
          serverId,
          maxPlayers,
          offline: false
        };
      }
    } catch (e) {
      result[serverId] = {
        serverId,
        online: 0,
        maxPlayers,
        map: "unknown",
        mode: "unknown",
        zombies: 0,
        survivors: 0,
        roomState: 0,
        players: [],
        timestamp: 0,
        offline: true
      };
    }
  }
  
  return corsResponse(new Response(JSON.stringify({ servers: result }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  }));
}

function corsResponse(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}