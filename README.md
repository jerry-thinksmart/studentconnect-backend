# StudentConnect backend

Node.js API backed by Supabase PostgreSQL, with Firebase Cloud Messaging (FCM) for push notifications.

## Setup

1. Use Node.js 22.13 or newer and run `npm install` in this directory.
2. Copy `.env.example` to `.env` and fill in the values.
3. Download a Firebase Admin service-account JSON and save it as `firebase-service-account.json` here. This file is ignored by Git.
4. Run `npm run migrate` and then `npm run dev`.
5. Verify the service with `GET http://localhost:3000/health`.

Use Supabase's Session pooler connection string if the deployment platform does not support IPv6. If a password is manually placed in a URI, characters such as `@`, `%`, `+`, `?`, and `*` must be URL-encoded; copying the completed URI from the Supabase dashboard is safer.

## Notification API

- `POST /api/v1/notifications/devices` registers an FCM token. Body: `{ "userId": "uuid", "token": "...", "platform": "android" }`.
- `DELETE /api/v1/notifications/devices` removes a token. Body: `{ "token": "..." }`.
- `POST /api/v1/notifications/send` sends to all registered devices for a user. Include the server-only `x-api-key` header and body `{ "userId": "uuid", "title": "...", "body": "...", "data": {} }`.

The device routes should be protected with your chosen user authentication before exposing this API publicly. The send route must only be called by trusted server/admin code; never embed `NOTIFICATION_API_KEY` in the Flutter application.

## Authentication API

- `POST /api/v1/auth/register` creates a user and returns a JWT plus the saved profile.
- `POST /api/v1/auth/login` validates the password and returns a JWT plus the profile.
- `GET /api/v1/auth/me` returns the current profile with `Authorization: Bearer <token>`.

Use `--dart-define=API_BASE_URL=http://127.0.0.1:3000/api/v1` for an iOS simulator. For an Android emulator use `http://10.0.2.2:3000/api/v1`; a physical device must use the development computer's LAN IP.

## Feature API

All routes below require `Authorization: Bearer <token>`:

- `/api/v1/classes` and `/api/v1/classes/:id/enroll`
- `/api/v1/feeds`, `/api/v1/feeds/:id/comments`, `/api/v1/feeds/:id/like`, and `/api/v1/feeds/:id/view`. `GET /feeds` returns public posts from every student, ranked by a score that weights unique views (plus likes and comments) against post age, so widely viewed posts are promoted. Each student's first view of someone else's post counts once.
- `/api/v1/scholarships` and `/api/v1/scholarships/:id/save`
- `/api/v1/events` and `/api/v1/events/:id/join`
- `/api/v1/communities/:id/resources` (`GET` list, `POST` share), `/api/v1/communities/:id/resources/:resourceId/file` (`GET` download) and `/api/v1/communities/:id/resources/:resourceId` (`DELETE`). Any approved member can share a file and every approved member can see and download it; only the uploader or a community admin can delete it. `POST` takes `{ title?, fileName, dataBase64 }` (up to 10 MB). Allowed types are pdf, jpg/jpeg, png, webp, doc/docx, xls/xlsx, ppt/pptx, txt and csv; the type is decided by the server from the extension and checked against the file's contents. Files are served only to approved members and always as a download (`Content-Disposition: attachment`).
- `/api/v1/communities/:id/quizzes` (`GET` list, `POST` schedule) and `/api/v1/communities/:id/quizzes/:quizId` (`DELETE`). Only community admins can schedule or delete; every approved member can list. `POST` takes `{ title, instructions?, startsAt, durationMinutes (1-600), testUrl? }` where `testUrl` must be `http(s)`. Each quiz is returned with a server-computed `status` (`upcoming`, `live` or `ended`), `endsAt`, and `cameraRequired: true`; the response also carries the server `now` so apps can count down against the server clock. The `testUrl` is only included for admins, or for members while the quiz is `live`. Camera enforcement is done by the app, not the server.
- `/api/v1/friends`
- `GET /api/v1/people?scope=all|nearby|career&q=&limit=&offset=` lists other students ranked by same city, same career path, then same country (`nearby` = same city or country, `career` = same career path). It returns only public profile fields plus the `conversationId` of an existing direct chat, and hides blocked users.
- `PATCH /api/v1/auth/me` updates `country`, `city`, `careerPath` and `institution` (also accepted by `register`). Run `npm run migrate` to add these columns.
- `POST /api/v1/conversations` with `{ "memberIds": ["<userId>"] }` starts a direct chat, or returns the existing one (`200`, `existing: true`) so a pair never gets duplicate conversations.
- `/api/v1/conversations` and `/api/v1/conversations/:id/messages`
- `/api/v1/library` and `/api/v1/library/:id/progress`
- `/api/v1/notifications` and `/api/v1/notifications/:id/read`

## Chat cache and high availability (SQLite)

PostgreSQL stays the source of truth for chat. Each API instance also keeps a local SQLite file (Node's built-in `node:sqlite`, WAL mode) at `CHAT_CACHE_PATH`:

- **Read cache:** every successful `GET /conversations/:id/messages` is written through to SQLite (latest 500 messages per conversation). If PostgreSQL is unreachable, the same route is served from the cache (`"source": "cache"`, header `X-Data-Source: cache`).
- **Offline outbox:** if PostgreSQL is unreachable, `POST /conversations/:id/messages` stores the message in SQLite and returns `202 { queued: true }`. The server assigns the message UUID, so the later upload is idempotent (`ON CONFLICT DO NOTHING`) and survives restarts. Clients may also send `clientMessageId` (a UUID) to make their own retries safe.
- **Sync:** every `CHAT_SYNC_INTERVAL_MS` a background loop probes PostgreSQL; when it answers, queued messages are uploaded in order with their original timestamps. Messages that fail `CHAT_MAX_SYNC_ATTEMPTS` times, or whose sender is no longer a member, are marked rejected and kept in SQLite for inspection.
- **Health:** `GET /health` returns `200` with `status: "degraded"` while PostgreSQL is down, plus cache/queue counters, so load balancers keep the node in rotation. The server also starts if PostgreSQL is down.
- **Limits:** offline access is only granted to users PostgreSQL has confirmed as members earlier; the cache is per instance (not shared), and only chat messages are cached. Put `CHAT_CACHE_PATH` on a persistent disk.

Run `npm test` to exercise the outage and recovery flow.
