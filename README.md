````markdown
# Unciv Cloudflare Worker (KV-backed)

This Cloudflare Worker implements the Unciv server endpoints using Cloudflare KV for storage.
No Redis, no Durable Objects, no external cloud storage.

Endpoints
- GET  /isalive
  - returns { authVersion: 1, chatVersion: 1 }

- GET  /files/:fileName
  - Requires Basic Auth (username = UUID, password)
  - Returns file contents stored under key `file:{fileName}`

- PUT  /files/:fileName
  - Requires Basic Auth
  - Body: file text
  - Stores to KV under `file:{fileName}`
  - If the file already exists, the provided password must match the stored password for the user

- GET  /auth
  - Requires Basic Auth
  - 204 => no password set for this user
  - 200 => password matches
  - 401 => password mismatch

- PUT  /auth
  - Requires Basic Auth (current password or none)
  - Body: new password (plain text)
  - Stores password under `auth:{userId}` in KV

- GET  /chat  (WebSocket upgrade)
  - Upgrade to WebSocket with Basic Auth header.
  - Messages (JSON with `type`):
    - { "type": "join",  "gameIds": ["uuid", ...] }
    - { "type": "leave", "gameIds": ["uuid", ...] }
    - { "type": "chat",  "civName": "...", "message": "...", "gameId": "..." }
  - Chat messages are broadcasted to connections on the same worker instance subscribed to the same gameId.

Important caveats
- Chat is in-memory per Worker instance. Cloudflare Workers are distributed and multiple instances may be used, so chat messages will not reach clients connected to other instances. If you need global chat, you must use Durable Objects, an external pub/sub, or similar mechanisms.
- KV is eventually consistent. For small files (<~100KB) KV is acceptable but keep in mind performance characteristics (writes propagate globally eventually).
- KV has per-value limits and operational characteristics. This solution is intended for small multiplayer save files (as requested).

Deployment
1. Create a KV namespace in Cloudflare dashboard or via wrangler and note its id.
2. Update `wrangler.toml` binding section with your KV namespace id.
3. Build & deploy with wrangler.

Security & notes
- Basic Auth uses the username as the userId (expected to be a UUID string).
- Passwords are stored in plaintext in KV in this example for simplicity. For stronger security you can store a hash (bcrypt/argon2) instead.
- Add rate limiting, input validation, and filename sanitization as needed before production use.
