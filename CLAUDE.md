# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a WhatsApp-based finance tracking MVP (Minimum Viable Product) that allows users to record income, expenses, and debts via WhatsApp messages in Portuguese. Transaction and debt parsing uses a hybrid approach: a fast regex parser for standard patterns (free) with OpenAI GPT-4o-mini as a fallback for ambiguous cases.

## Architecture

This is a single-file Express.js application with a simple architecture:

- **Entry point**: `index.js` - Contains the entire application
- **Database**: MongoDB (using native driver) with `transactions` and `debts` collections
- **LLM Parsing**: OpenAI GPT-4o-mini for extracting transaction/debt details from Portuguese text (fallback only)
- **Regex Parsing**: Fast, cost-free parser handling standard patterns:
  - Income: vendi, recebi, ganhei, paiei, biolo, fezada
  - Expense: comprei, gastei, paguei, gasto, pagamento, emprestei, transferi, enviei
  - Debt: "X me deve", "eu devo", "devo", "emprestei a"
  - Description extraction: "de/do/da X", "para X", "em X" (e.g., "gastei 1000 em compras")
- **Messaging**: Twilio WhatsApp API for user communication
- **Session Management**: MongoDB-backed with in-memory cache - sessions persist across restarts with 30min TTL; both MongoDB and in-memory entries enforce TTL; in-memory cache uses hashed phone keys (never raw phone numbers); dirty flag reduces redundant MongoDB writes; stale sessions cleared after MongoDB reconnection
- **Deduplication**: `processedMessages` in-memory Set tracks `MessageSid` values with a 10,000 message FIFO limit; pre-populated from MongoDB on startup to catch Twilio retries after restart; performance optimization only (MongoDB unique indexes on `message_sid` catch true duplicates)
- **Response Cache**: In-memory LRU cache (1000 entries, 24h TTL) for parsed results to avoid reprocessing identical messages; error responses are NOT cached; resets on restart (cold cache until warm-up)
- **Rate Limiting**: MongoDB-backed per-user daily limit (50 messages/day) via `rate_limits` collection with TTL index; counter capped to prevent unbounded growth; rate limit notification sent only once per day; persists across restarts; checked before event logging; deleted on `/apagar`
- **Event Logging**: `message_sent` events only logged for consenting users (after onboarding check) — non-consenting users generate no persistent audit data
- **Admin Commands**: `/stats` command for authorized phone numbers shows cache hit rate and performance metrics; non-admin users receive explicit rejection
- **User Commands**: `/mes` (monthly summary), `/resumo` (7-day summary), `/ajuda` (help menu), `/termos` (terms of use), `/privacidade` (privacy policy)
- **Privacy Commands**: `/meusdados` (view user data — last 100 transactions), `/apagar` (delete all data atomically - right to be forgotten, also deletes rate_limits)

### Security Features

- **ReDoS Protection**: Safe regex patterns prevent catastrophic backtracking attacks
- **Input Validation**: Amount values validated for range and type before processing (both at parse time and confirmation time)
- **Webhook Signature Verification**: Mandatory SHA256 signature validation via `x-twilio-signature` header — all requests without valid signature are rejected (401)
- **Input Sanitization**: Control characters, zero-width characters (U+200B-200D, FEFF), and directional overrides (U+202A-202E) stripped from user messages; OpenAI prompt input truncated to 500 chars with quote escaping (`sanitizeForPrompt`)
- **OpenAI Error Handling**: API failures handled gracefully with user-friendly error messages; 10s timeout on all API calls; unhandled Promise rejections from `Promise.race` neutralized; error responses are NOT cached (prevents prolonged degradation)
- **Graceful Shutdown**: HTTP server drained and MongoDB connection properly closed on SIGTERM/SIGINT
- **Rate Limiting**: Per-user daily limit (50 messages) backed by MongoDB (`rate_limits` collection with TTL index) — persists across restarts; counter capped at MAX+1 to prevent unbounded growth; notification sent only once per day; checked before event logging to prevent stat inflation
- **Global Error Handler**: `asyncHandler` wrapper forwards unhandled async errors to Express middleware, preventing process crashes
- **Helmet**: HTTP security headers via `helmet` middleware
- **Webhook Timeout**: 12s timeout on webhook handler — responds 504 if Twilio's 15s limit is approached; prevents hanging connections
- **OpenAI Health Tracking**: `openaiHealthy` flag reflects last OpenAI call status; included in `/health` JSON response

### Key Components

1. **Webhook Handler** (`POST /webhook`): Receives WhatsApp messages via Twilio
   - Message deduplication using `MessageSid` (returns 204 for duplicates)
   - Parses incoming messages normalized to lowercase
   - Handles commands: `hoje`, `/quemedeve`, `/quemdevo`, `/kilapi`, `/pago <name>` (requires confirmation), `/stats` (admin only), `/mes`, `/resumo`, `/ajuda`, `/meusdados`, `/apagar`, `/privacidade`, `/termos`
   - Manages multiple session states: `IDLE`, `AWAITING_CONSENT`, `ONBOARDING_COMPLETE`, `AWAITING_CONFIRMATION`, `AWAITING_DEBT_CONFIRMATION`, `AWAITING_DEBTOR_NAME`, `AWAITING_PAGO_CONFIRM`, `AWAITING_APAGAR_CONFIRM`
   - Commands typed during an active confirmation session reset the session to IDLE (prevents stale state misinterpretation)

2. **Transaction Parsing** (`parseTransaction`): Hybrid parser that:
   - First tries regex-based parsing (fast, free) for standard patterns
   - Falls back to OpenAI for ambiguous cases
   - Extracts `type` (income/expense), `amount`, and `description`
   - Description patterns (in order): "para X" (transfers), "de/do/da X" (purchases), "em X" (expenses/income)
   - Safe regex patterns prevent ReDoS attacks

3. **Debt Parsing** (`parseDebt`): Hybrid parser that:
   - First tries regex-based parsing for debt patterns
   - Falls back to OpenAI for ambiguous cases
   - Extracts `type` (recebido/devido), `creditor`, `debtor`, and `amount`

4. **Onboarding & Consent Flow**: New users must give consent before data is stored (Lei 22/11 compliance)
   - Consent recorded with `consent_given` event
   - `/meusdados` shows all stored user data
   - `/apagar` permanently deletes user data (right to be forgotten)

5. **Confirmation Flow**: Parsed transactions and debts require user confirmation (sim/nao) before database insertion; `/pago` also requires confirmation before marking a debt as settled; amounts are re-validated at confirmation time (`Number.isFinite`, positive, max 1B)

6. **Response Cache** (`getCachedResponse`, `setCachedResponse`): LRU cache implementation
   - Caches parsed results by message text + parser type (transaction/debt)
   - 1000 entry limit with LRU eviction
   - 24-hour TTL for cache entries
   - Cache statistics via `/stats` admin command

7. **Database Indexes**:
   - `transactions`: `{ user_hash: 1, date: -1 }` for date range queries, `{ message_sid: 1 }` unique
   - `debts`: `{ user_hash: 1, settled: 1 }`, `{ user_hash: 1, creditor: 1, debtor: 1 }`, `{ message_sid: 1 }` unique
   - `events`: `{ event_name: 1, timestamp: -1 }`, `{ user_hash: 1, timestamp: -1 }`, `{ timestamp: 1 }` (partial TTL — auto-deletes `data_deleted` audit records after 2 years)
   - `sessions`: `{ phone_hash: 1 }` unique, `{ updatedAt: 1 }` (TTL 1800s)
   - `rate_limits`: `{ resetAt: 1 }` (TTL — expired entries auto-deleted by MongoDB)
   - `_migrations`: Tracks completed schema migrations to prevent re-execution

### Sprint 9 - Completed (Security & Stability)
- **Webhook Signature Verification**: Mandatory SHA256 validation of Twilio signatures (no bypass path)
- **Input Sanitization**: Control character, zero-width, and directional override stripping
- **Rate Limiting**: 50 messages/user/day backed by MongoDB `rate_limits` collection with TTL index; persists across restarts
- **MongoDB Connection Retry**: Exponential backoff with 10 retries; concurrent reconnection guard
- **Session Persistence**: MongoDB-backed sessions with 30min TTL; in-memory cache TTL enforced; `phone_hash` replaces raw phone numbers

### Post-Sprint 9 - Completed (Privacy & Reliability)
- **Full Phone Hashing**: All collections use `user_hash`/`phone_hash` (SHA-256); `user_phone` removed from documents via migration `$unset`
- **Transaction Amount Validation**: Amounts validated at both parse and confirmation time; invalid amounts rejected before confirmation prompt
- **Angola Timezone**: All date queries and rate limiting use UTC+1 offset via `getAngolaMidnightUTC()`
- **Global Error Handler**: `asyncHandler` wrapper prevents unhandled async rejections from crashing the process
- **OpenAI Error Caching**: Error responses are NOT cached, preventing prolonged degradation after transient failures
- **Deterministic Debt Settlement**: `/pago` uses oldest-first sort when multiple debts match
- **Amount Safety in Summaries**: All accumulation loops use `Number.isFinite()` guards
- **Transferi + minha conta**: "transferi para a minha conta" correctly classified as income (not expense)
- **Trust Proxy**: `app.set('trust proxy', 1)` for correct signature verification behind Railway/reverse proxy
- **Health Check**: `/health` returns 503 when MongoDB is disconnected
- **Decimal Amounts**: `parseFloat` replaces `parseInt` in regex parsers to preserve decimal values
- **Session TTL Coupling**: `SESSION_TTL_MS` constant drives both app logic and MongoDB TTL index
- **Multi-word Descriptions**: `de/do/da/dos/das` pattern captures full multi-word descriptions (e.g., "pao de trigo")

### Round 6 - Completed (35 Fixes — P0 through P3)
- **Debt Flow Fix (P0-1)**: AWAITING_DEBTOR_NAME now only entered when counterparty is truly unknown (not for regex-parsed debts); name update logic corrected to write the right field; confirmation step added before insert
- **OpenAI Timeout (P0-2)**: `Promise.race` losing promise rejections neutralized with `.catch(() => {})` in both debt and transaction parsers
- **Atomic /apagar (P0-3)**: All deletions wrapped in MongoDB transaction; partial failures no longer leave orphaned data
- **rate_limits Deletion (P0-4)**: `/apagar` also deletes rate_limits entries (uses regex on raw phone digits since rate_limits doesn't use user_hash)
- **Session Key Hashing (P1-3)**: In-memory session cache uses `hashPhone(from)` as key — raw phone numbers never appear as object keys
- **/pago Confirmation (P1-4+P1-5)**: `/pago <name>` now requires sim/nao confirmation before settling; after settling, shows count of remaining debts with same name
- **Audit TTL Index (P1-2)**: `data_deleted` audit records auto-deleted after 2 years via partial filter TTL index
- **Duplicate Key Silence (P1-6)**: Duplicate key errors in AWAITING_DEBT_CONFIRMATION no longer send redundant "Dívida registada" messages
- **Prompt Sanitization (P1-7+P1-8)**: User input truncated to 500 chars and quote-escaped before OpenAI calls
- **Session Dirty Flag (P2-3)**: MongoDB session writes only when state actually changes — reduces writes from ~1 per webhook to ~0.3
- **Rate Limit Improvements (P2-7+P2-8+P2-9)**: Zero-padded date format; counter capped at MAX+1; notification sent only once per day
- **Non-Admin /stats (P2-1)**: Explicit rejection message instead of silent 204
- **/meusdados Limit (P2-2)**: Last 100 transactions with total count shown
- **Migration Guard (P2-5)**: `_migrations` collection prevents re-execution of completed schema migrations
- **Webhook Timeout (P2-11)**: 12s timeout with 504 response; cleanup via `res.on('finish')`
- **WEBHOOK_URL (P2-12)**: Optional env var for explicit signature verification URL
- **Dedup Set Pre-population (P2-6)**: `processedMessages` loaded from recent DB records on startup
- **hashPhone Collision Comment (P2-4)**: Documented 64-bit collision ceiling (safe for MVP, increase before scaling)
- **Helmet (P3-3)**: HTTP security headers middleware
- **OpenAI Schema Validation (P3-4)**: Response JSON checked for required keys before use
- **OpenAI Health Flag (P3-7)**: `openaiHealthy` flag tracks last call status; included in `/health` response
- **Infinite MongoDB Retry (P3-9)**: After 10 fast retries, switches to infinite retry at 60s intervals instead of `process.exit(1)`
- **Financial Data Redaction (P3-8)**: `logEvent` metadata only includes type — amounts and descriptions removed
- **isMainModule Fix (P3-2)**: Uses `pathToFileURL` for reliable module detection instead of filename comparison

### Round 7 - Completed (7 Fixes — P1 through P3)
- **Debtor Name Update Fix (P1-1)**: AWAITING_DEBTOR_NAME name update condition corrected — now matches the entry condition (`debtor==="user"` for recebido, `creditor==="user"` for devido), preventing silent name discards
- **Event Logging After Consent (P1-2)**: `logEvent('message_sent')` moved after the consent check so non-consenting users don't generate persistent audit events (Lei 22/11 compliance)
- **Multi-word `em` Descriptions (P2-1)**: Regex `em\s+(.+?)` (lazy) changed to `em\s+(.+)$` (greedy) — multi-word descriptions like "material escolar" no longer truncated
- **Empty-string Creditor/Debtor Validation (P2-2)**: Added `.trim().length > 0` check on creditor and debtor strings to prevent OpenAI from inserting empty names
- **/apagar Error Feedback (P2-3)**: MongoDB transaction failure now sends WhatsApp error message instead of silently returning 500
- **PRIVACY.md Accuracy (P3-1)**: Corrected SHA-256 claim to note that rate_limits uses normalized phone digits; corrected atomic deletion claim to note rate_limits runs outside the transaction

## Environment Variables

Required:
- `MONGODB_URI` - MongoDB connection string
- `OPENAI_API_KEY` - OpenAI API key
- `TWILIO_ACCOUNT_SID` - Twilio account SID
- `TWILIO_AUTH_TOKEN` - Twilio auth token

Optional:
- `PORT` - Server port (default: 3000)
- `TWILIO_WHATSAPP_NUMBER` - Default: whatsapp:+14155238886
- `ADMIN_NUMBERS` - Comma-separated WhatsApp numbers for admin commands (overrides hardcoded values)
- `WEBHOOK_URL` - Full URL for Twilio signature verification (e.g., `https://contador.app/webhook`)

Admin phone numbers (from env with fallback):
- `whatsapp:+244912756717`
- `whatsapp:+351936123127`

## Testing

Test files import pure functions from `index.js` via ES module exports. The server startup (MongoDB connect, Express listen) is guarded by an `isMainModule` check and does NOT run when imported by tests.

```bash
# Run parser tests (no server or MongoDB required)
node test-transaction-fix.js
node test-debt-parser.js
node test-transfer.js

# Run cache tests (no server required, tests in-memory cache functions)
node test-cache.js
node test-cache-integration.js
node test-cache-direct.js

# Run webhook integration tests (requires running server)
node test-webhook-cache.js

# Run the server (requires environment variables)
node index.js
```

## Development

```bash
# Check syntax
node --check index.js

# View current git status
git status

# Push changes
git push
```

## API Endpoints

- `POST /webhook` - Twilio WhatsApp webhook for incoming messages
- `GET /health` - Health check endpoint returns JSON with `mongodb` and `openai` status; returns 503 when MongoDB is disconnected

## Data Model

### Events Collection (Audit Log)
```javascript
{
  user_hash: string,         // SHA-256 hash of phone number (privacy compliance) — sole user identifier in events
  event_name: string,        // e.g., 'first_use', 'consent_given', 'message_sent', 'transaction_confirmed'
  event_data: object,        // Event-specific data
  timestamp: Date            // When event occurred
}
```

### Transactions Collection
```javascript
{
  message_sid: string,     // Twilio MessageSid for deduplication
  user_hash: string,        // SHA-256 hash of phone number (privacy compliance) — replaces user_phone
  type: "income" | "expense",
  amount: number,
  description: string,
  date: Date
}
```

### Debts Collection
```javascript
{
  message_sid: string,        // Twilio MessageSid for deduplication
  user_hash: string,           // SHA-256 hash of phone number (privacy compliance) — replaces user_phone
  type: "recebido" | "devido", // "recebido" = someone owes user, "devido" = user owes someone
  creditor: string,           // Who is owed money
  debtor: string,             // Who owes money
  amount: number,
  description: string,
  date: Date,
  settled: boolean,           // Whether debt has been paid
  settled_date: Date|null     // When debt was paid
}
```

Note: Duplicate key errors (code 11000) on `message_sid` are silently ignored to handle Twilio retries.

### Rate Limits Collection
```javascript
{
  _id: string,              // "{normalizedPhone}:{angolaDate}" — composite key
  count: number,            // Message count for current day
  resetAt: Date             // When this rate limit window expires (TTL index auto-deletes)
}
```

## Database Index Management

**IMPORTANT**: Index names are auto-generated by MongoDB based on the index specification. When modifying indexes:

1. **Never create the same index twice** - MongoDB will throw `IndexKeySpecsConflict` (code 86) if an index with the same name already exists

2. **Check existing indexes before adding new ones** - The `message_sid_1` index exists on both collections from initial deployment

3. **Handle index conflicts gracefully** - Use try-catch with error code 86 when creating indexes:
   ```javascript
   try {
     await collection.createIndex({ field: 1 }, { unique: true });
   } catch (err) {
     if (err.code !== 86) throw err; // Ignore "index already exists" errors
   }
   ```

4. **Current Indexes**:
   - `transactions`: `{ user_hash: 1, date: -1 }`, `{ message_sid: 1 }` (unique)
   - `debts`: `{ user_hash: 1, settled: 1 }`, `{ user_hash: 1, creditor: 1, debtor: 1 }`, `{ message_sid: 1 }` (unique)
   - `sessions`: `{ phone_hash: 1 }` (unique), `{ updatedAt: 1 }` (TTL 1800s)
   - `events`: `{ event_name: 1, timestamp: -1 }`, `{ user_hash: 1, timestamp: -1 }`, `{ timestamp: 1 }` (partial TTL on `data_deleted` — 2 year retention)
   - `rate_limits`: `{ resetAt: 1 }` (TTL auto-delete)
   - `_migrations`: no special indexes (used as guard collection)

## Security Considerations

- **ReDoS Protection**: Amount extraction regex uses non-catastrophic pattern `/(\d[\d\s]*?)\s*(?:kz|paus)?$/i`
- **Input Validation**: Amount values checked for `Number.isFinite()`, positive values, and max limit (1B)
- **Error Handling**: OpenAI API failures return service unavailable error without exposing stack traces
- **OpenAI Prompt Sanitization**: User input truncated to 500 chars and quote-escaped before passing to OpenAI; prevents prompt injection
- **Logging**: Financial data (amounts, descriptions) redacted from event log metadata; only type retained
- **Graceful Shutdown**: HTTP server drained and MongoDB connection closed properly on server termination

## Cost Optimization

The regex parser handles ~90% of standard messages (e.g., "vendi 1000 Kz de fuba", "comprei pão") for free. OpenAI is only called when the regex parser returns `ambiguous`, significantly reducing API costs while maintaining reliability for edge cases.

### Cache Impact

The response cache further reduces costs by storing parsed results for identical messages:
- **Cache hit rate**: ~50% for repeated messages
- **Storage**: In-memory LRU with 1000 entry limit
- **TTL**: 24 hours
- **Monitoring**: `/stats` command shows hit rate, entries, and performance metrics

**Response Caching**: Identical messages are cached for 24 hours, eliminating redundant OpenAI API calls for repeated patterns (e.g., daily "vendi pão" messages). Cache statistics available via `/stats` admin command.
