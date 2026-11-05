# player_data payload

Per-player events, sent as their own payload (separate from `/api/round-complete`).
First use: when a player leaves, send how long they played.

```
POST https://primal-game-production.up.railway.app/api/player-data
x-api-key: <same ingest key as /api/round-complete>      (or Authorization: Bearer <key>)
Content-Type: application/json
```

## Shape

One player:

```json
{ "UserId": "12345678", "Event": "leave", "SessionId": "<JobId>:12345678", "PlayTimeSeconds": 912.5,
  "Platform": "Mobile", "TouchEnabled": true, "PreferredInput": "Touch" }
```

Several players in one request (up to 200, body under 100 KB):

```json
{ "Players": [ { "UserId": "1", "PlayTimeSeconds": 40 }, { "UserId": "2", "PlayTimeSeconds": 75 } ] }
```

The Logger.Send wrapper works too: `{ "level": "info", "placeId": 123, "time": 1762300000, "data": { ... } }`
(`placeId` and `time` are read from the outer body when the entry has none of its own).

## Fields

Names are matched ignoring case, underscores and dashes (`UserId`, `userId`, `user_id` are the same).

| Column | Accepted names | Notes |
|---|---|---|
| `roblox_user_id` | UserId, RobloxUserId, PlayerId | **Required.** Positive whole number; send it as a string. |
| `event` | Event, EventType, Action | e.g. `leave`. Stored lower-case. Missing = `unspecified` (not guessed). |
| `session_id` | SessionId | Recommended. Makes a resend of the same event harmless (unique per `session_id` + `event`). |
| `play_time_seconds` | PlayTimeSeconds, PlayTime, DurationSeconds, Duration | **Seconds.** Negative or non-numeric becomes null (the raw value is kept in `extra`). |
| `platform` | Platform | |
| `touch_enabled` | TouchEnabled | true / false |
| `preferred_input` | PreferredInput | |
| `place_id` | PlaceId | Falls back to the outer body's `placeId`. |
| `occurred_at` | Time, Timestamp, OccurredAt, LeftAt | Unix seconds, unix milliseconds or ISO text. Falls back to the outer `time`; otherwise empty (`received_at` is always set). |
| `extra` | anything else | Every field not listed above is stored as JSON, so new stats can be added on the game side without a schema change. Over 8 KB it is replaced by a marker listing the keys. |

NaN: the game's `{"t":"numeric","v":"nan"}` wrapper is unwrapped to null, same as round data.

## Answers

- `200 { received, accepted, rejected }` - queued. `rejectedEntries` lists entries that had no usable `UserId` (the rest were still accepted).
- `400` - nothing usable (reason in `error`). A bad payload also posts a notice in the ingestion-errors channel, at most once per 10 minutes.
- `401` - wrong or missing key.
- `503` + `Retry-After: 30` - the write queue is full (database trouble). Rows already accepted are safe; this one was not.

A `200` means queued, not yet in the database: rows are written in batches about every second and retried until they land.
Table: `player_data` in Supabase (service key only; the website will read it through RPCs).
