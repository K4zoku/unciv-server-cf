/**
 * UncivServer -> Cloudflare Worker (TypeScript) using KV only (no Redis, no Durable Objects)
 *
 * Endpoints:
 *   - GET  /isalive
 *   - GET  /files/:fileName   (Basic Auth required)
 *   - PUT  /files/:fileName   (Basic Auth required)
 *   - GET  /auth              (Basic Auth required)
 *   - PUT  /auth              (Basic Auth required)
 *   - GET  /chat              (WebSocket upgrade; Basic Auth required)
 *
 * Storage:
 *   - KV Namespace bound as UNCIV_KV
 *     - auth:{userId} -> password (string)
 *     - file:{fileName} -> file text (string)
 *
 * Notes:
 *  - Chat is implemented in-memory per Worker instance (no Durable Objects). That means:
 *      * WebSocket connections are handled by the worker instance that accepted the connection.
 *      * Broadcasts will only reach connections handled by the same instance. In a multi-instance
 *        deployment, chat messages won't be propagated across instances.
 *    If you need global chat propagation, you must use Durable Objects, an external pub/sub, or other means.
 *
 *  - File sizes: KV is eventually consistent and has object size limits. For files under ~100KB this is fine.
 *
 * Usage:
 *   - Bind your KV namespace in wrangler.toml with binding name "UNCIV_KV".
 *
 */
type Env = {
  UNCIV_KV: KVNamespace;
};

const IS_ALIVE = { authVersion: 1, chatVersion: 1 };

function parseBasicAuth(header?: string | null) {
  if (!header) return null;
  const m = header.match(/Basic\s+(.*)/i);
  if (!m) return null;
  try {
    const decoded = atob(m[1]);
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    const id = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);
    return { userId: id, password };
  } catch {
    return null;
  }
}

const AUTH_PREFIX = "auth:";
const FILE_PREFIX = "file:";

function authKeyFor(userId: string) {
  return `${AUTH_PREFIX}${userId}`;
}
function fileKeyFor(fileName: string) {
  return `${FILE_PREFIX}${fileName}`;
}

async function kvGet(env: Env, key: string): Promise<string | null> {
  const v = await env.UNCIV_KV.get(key);
  return v === null ? null : v;
}

async function kvPut(env: Env, key: string, value: string): Promise<void> {
  await env.UNCIV_KV.put(key, value);
}

async function kvDel(env: Env, key: string): Promise<void> {
  await env.UNCIV_KV.delete(key);
}

async function validateAuth(env: Env, userId: string, password: string | null): Promise<boolean> {
  const serverPassword = await kvGet(env, authKeyFor(userId));
  if (serverPassword === null) return true;
  return password !== null && serverPassword === password;
}

/**
 * Lightweight in-memory WebSocket session manager for this worker instance.
 * Map: WebSocket -> Set<gameId>
 */
const wsSessions = new Map<WebSocket, Set<string>>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // isalive
    if (path === "/isalive" && request.method === "GET") {
      return new Response(JSON.stringify(IS_ALIVE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // chat (websocket upgrade)
    if (path === "/chat") {
      const auth = parseBasicAuth(request.headers.get("Authorization"));
      if (!auth) {
        return new Response("No authentication info found!", { status: 400 });
      }
      const ok = await validateAuth(env, auth.userId, auth.password);
      if (!ok) {
        return new Response("Authentication failed!", { status: 401 });
      }

      const upgradeHeader = request.headers.get("Upgrade") || "";
      if (upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("This endpoint only accepts WebSocket upgrades", { status: 400 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      // setup event handlers
      server.addEventListener("message", (evt: MessageEvent) => {
        try {
          const data = typeof evt.data === "string" ? JSON.parse(evt.data) : null;
          if (!data || typeof data.type !== "string") {
            server.send(JSON.stringify({ type: "error", message: "Malformed message" }));
            return;
          }

          switch (data.type) {
            case "join": {
              const gameIds: string[] = Array.isArray(data.gameIds) ? data.gameIds : [];
              let set = wsSessions.get(server);
              if (!set) {
                set = new Set<string>();
                wsSessions.set(server, set);
              }
              for (const gid of gameIds) if (typeof gid === "string") set.add(gid);
              server.send(JSON.stringify({ type: "joinSuccess", gameIds: [...set] }));
              break;
            }

            case "leave": {
              const gameIds: string[] = Array.isArray(data.gameIds) ? data.gameIds : [];
              const set = wsSessions.get(server);
              if (set) {
                for (const gid of gameIds) set.delete(gid);
                server.send(JSON.stringify({ type: "leaveSuccess", gameIds: [...set] }));
              }
              break;
            }

            case "chat": {
              const { civName, message, gameId } = data;
              if (typeof gameId !== "string") {
                server.send(JSON.stringify({ type: "error", message: "Invalid or missing gameId" }));
                return;
              }
              const set = wsSessions.get(server);
              if (!set || !set.has(gameId)) {
                server.send(JSON.stringify({ type: "error", message: "You are not subscribed to this channel!" }));
                return;
              }
              const payload = JSON.stringify({
                type: "chat",
                civName,
                message,
                gameId,
              });
              // broadcast to all connections in this worker instance subscribed to gameId
              for (const [ws, subSet] of wsSessions.entries()) {
                if (subSet.has(gameId)) {
                  try {
                    ws.send(payload);
                  } catch {
                    // ignore send errors; close event will cleanup
                  }
                }
              }
              break;
            }

            default:
              server.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
          }
        } catch (err) {
          try {
            server.send(JSON.stringify({ type: "error", message: (err as Error).message || "server error" }));
          } catch {}
        }
      });

      server.addEventListener("close", () => {
        wsSessions.delete(server);
      });
      server.addEventListener("error", () => {
        wsSessions.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // files endpoints
    if (path.startsWith("/files/")) {
      const fileName = decodeURIComponent(path.slice("/files/".length));
      const auth = parseBasicAuth(request.headers.get("Authorization"));
      if (!auth) {
        return new Response("Possibly malformed authentication header!", { status: 400 });
      }
      const { userId, password } = auth;

      if (request.method === "PUT") {
        const existing = await kvGet(env, fileKeyFor(fileName));
        if (existing !== null) {
          // If file exists, require correct password
          const allowed = await validateAuth(env, userId, password);
          if (!allowed) return new Response("Unauthorized", { status: 401 });
        }
        const bodyText = await request.text();
        await kvPut(env, fileKeyFor(fileName), bodyText);
        return new Response(null, { status: 200 });
      }

      if (request.method === "GET") {
        const existing = await kvGet(env, fileKeyFor(fileName));
        if (existing === null) return new Response("File does not exist", { status: 404 });
        const allowed = await validateAuth(env, userId, password);
        if (!allowed) return new Response("Unauthorized", { status: 401 });

        return new Response(existing, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          },
        });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // auth endpoints
    if (path === "/auth") {
      const auth = parseBasicAuth(request.headers.get("Authorization"));
      if (!auth) {
        return new Response("Possibly malformed authentication header!", { status: 400 });
      }
      const { userId, password } = auth;

      if (request.method === "GET") {
        const serverPassword = await kvGet(env, authKeyFor(userId));
        if (serverPassword === null) return new Response(null, { status: 204 });
        if (serverPassword === password) return new Response(null, { status: 200 });
        return new Response("Unauthorized", { status: 401 });
      }

      if (request.method === "PUT") {
        const serverPassword = await kvGet(env, authKeyFor(userId));
        if (serverPassword !== null && serverPassword !== password) return new Response("Unauthorized", { status: 401 });
        const newPassword = await request.text();
        if (newPassword.length < 6) return new Response("Password should be at least 6 characters long", { status: 400 });
        await kvPut(env, authKeyFor(userId), newPassword);
        return new Response(null, { status: 200 });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
};
