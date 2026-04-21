# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a WhatsApp-based finance tracking MVP that allows users to record income, expenses, and debts via WhatsApp messages in Portuguese. Transaction and debt parsing uses a hybrid approach: a fast regex parser for standard patterns (free) with OpenAI GPT-4o-mini as a fallback for ambiguous cases.

## Architecture

Modular Express.js application with handlers extracted into `lib/` modules:

- **Entry point**: `index.js` — Express server, webhook handler, MongoDB connection, session management
- **Command handlers**: `lib/commands.js` — 22 handler functions receiving a `ctx` context object
- **Security utilities**: `lib/security.js` — hashing, sanitization, validation, session states, schema validators
- **Parsers**: `lib/parsers.js` — regex-based transaction and debt parsers
- **Cache**: `lib/cache.js` — LRU response cache for parsed results
- **Database**: MongoDB (native driver) with `transactions`, `debts`, `events`, `sessions`, `rate_limits`, `feedback`, `onboarding` collections
- **LLM Parsing**: OpenAI GPT-4o-mini for ambiguous cases (fallback only)
- **Messaging**: Twilio WhatsApp API for user communication

### Regex Parsing Patterns
- Income: vendi, recebi, ganhei, paiei, biolo, fezada
- Expense: comprei, gastei, paguei, gasto, pagamento, transferi, enviei
- Debt: "X me deve", "eu devo", "devo", "emprestei a"
- Description extraction: "de/do/da X", "para X", "em X" (e.g., "gastei 1000 em compras")

### Session Management
MongoDB-backed with in-memory cache — sessions persist across restarts with 30min TTL; both MongoDB and in-memory entries enforce TTL; in-memory cache uses hashed phone keys (never raw phone numbers); dirty flag reduces redundant MongoDB writes; stale sessions cleared after MongoDB reconnection

### Deduplication
`processedMessages` in-memory Set tracks `MessageSid` values with a 10,000 message FIFO limit; pre-populated from MongoDB on startup; performance optimization only (MongoDB unique indexes on `message_sid` catch true duplicates)

### Response Cache
In-memory LRU cache (1000 entries, 24h TTL) for parsed results; error responses NOT cached; resets on restart

### Rate Limiting
- **Per-user**: MongoDB-backed 50 messages/day via `rate_limits` collection with TTL index; counter capped at MAX+1; notification sent only once per day; persists across restarts; deleted on `/apagar`
- **Per-IP**: `express-rate-limit` middleware — 100 req/min global, 30 req/min for `/health`

## Commands

### User Commands
- `hoje` / `/hoje` — Today's balance
- `/resumo` — 7-day summary
- `/mes` — Monthly summary
- `/quemedeve` — Who owes you (paginated)
- `/quemdevo` — Who you owe (paginated)
- `/kilapi` — All debts (paginated)
- `/pago <name>` — Mark debt as paid (requires confirmation)
- `/desfazer` — Undo last record (requires confirmation)
- `/meusdados` — View your data (phone masked, totals from all transactions)
- `/exportar` — Export all your data (Lei 22/11 portability)
- `/apagar` — Delete all your data atomically (requires confirmation)
- `/ajuda` — Help menu
- `/feedback <text>` — Send feedback or report a problem
- `/privacidade` — Privacy policy
- `/termos` — Terms of use

### Admin Commands
- `/stats` — Daily metrics (authorized phone numbers only)
- `/retencao` — Retention analytics with day-1/7/30 cohorts (admin only)
- `/anunciar <text>` — Broadcast message to all consented users (admin only)

## Session States

`IDLE`, `AWAITING_CONFIRMATION`, `AWAITING_DEBT_CONFIRMATION`, `AWAITING_DEBTOR_NAME`, `AWAITING_PAGO_CONFIRM`, `AWAITING_APAGAR_CONFIRM`, `AWAITING_DESFAZER_CONFIRM`

Onboarding states (stored in `onboarding` collection, separate from session): `AWAITING_CONSENT`, `COMPLETED`

Commands typed during an active confirmation session reset the session to IDLE (prevents stale state misinterpretation).

## Security Features

- **Webhook Signature Verification**: Mandatory SHA256 validation via `x-twilio-signature` header — all requests without valid signature are rejected (401)
- **IP-based Rate Limiting**: `express-rate-limit` — 100 req/min global, 30 req/min for `/health`
- **Per-User Rate Limiting**: 50 messages/user/day backed by MongoDB with TTL index
- **Input Sanitization**: Control characters, zero-width characters (U+200B-200D, FEFF), and directional overrides (U+202A-202E) stripped
- **OpenAI Prompt Sanitization**: User input truncated to 500 chars, quote-escaped, and filtered for injection patterns ("ignore previous", "disregard the above", "act as admin", role injection, etc.)
- **OpenAI Response Schema Validation**: `validateTransactionResponse` and `validateDebtResponse` enforce field types, cap string lengths (200 chars description, 50 chars name), and strip extra keys before MongoDB storage
- **Message Body Size Limit**: Messages over 2000 chars rejected with 413
- **Input Validation**: Amount values validated for `Number.isFinite()`, positive values, and max 1B at both parse and confirmation time
- **Graceful Shutdown**: HTTP server drained and MongoDB connection closed on SIGTERM/SIGINT; `uncaughtException` always exits gracefully
- **Helmet**: HTTP security headers middleware
- **Webhook Timeout**: 12s timeout — responds 504 if Twilio's 15s limit is approached
- **MongoDB Disconnect Guard**: Returns 503 when MongoDB is disconnected (prevents 500 storms)
- **Transaction Support Detection**: Detects replica set at startup; `/apagar` uses sequential fallback on standalone MongoDB

## Environment Variables

Required:
- `MONGODB_URI` - MongoDB connection string
- `OPENAI_API_KEY` - OpenAI API key
- `TWILIO_ACCOUNT_SID` - Twilio account SID
- `TWILIO_AUTH_TOKEN` - Twilio auth token

Optional:
- `PORT` - Server port (default: 3000)
- `TWILIO_WHATSAPP_NUMBER` - Default: whatsapp:+14155238886
- `WEBHOOK_URL` - Full URL for Twilio signature verification (strongly recommended for production; falls back to header-based reconstruction if unset)
- `ADMIN_NUMBERS` - Comma-separated WhatsApp numbers for admin commands (defaults to empty array if unset)

## Testing

```bash
# Run unit tests (no MongoDB required)
npm test

# Run integration tests (requires mongodb-memory-server)
npm run test:integration

# Run all tests
npm run test:all

# Check syntax
node --check index.js
```

## API Endpoints

- `POST /webhook` - Twilio WhatsApp webhook for incoming messages
- `GET /health` - Health check (503 when starting or MongoDB disconnected; does NOT expose OpenAI status)

## Data Model

### Transactions Collection
```javascript
{
  message_sid: string,     // Twilio MessageSid for deduplication
  user_hash: string,        // SHA-256 hash of phone number
  type: "income" | "expense",
  amount: number,
  description: string,     // Max 200 chars (validated by schema)
  date: Date
}
```

### Debts Collection
```javascript
{
  message_sid: string,
  user_hash: string,
  type: "recebido" | "devido",
  creditor: string,         // Max 50 chars (validated by schema)
  debtor: string,           // Max 50 chars (validated by schema)
  amount: number,
  description: string,     // Max 200 chars (validated by schema)
  date: Date,
  settled: boolean,
  settled_date: Date|null
}
```

### Feedback Collection
```javascript
{
  user_hash: string,
  text: string,             // Max 500 chars
  date: Date,
  message_sid: string
}
```

### Broadcast List Collection
```javascript
{
  user_hash: string,        // SHA-256 hash of phone number (unique index)
  phone: string,            // Raw phone for Twilio delivery (isolated PII)
  updated_at: Date
}
```

### Events Collection (Audit Log)
```javascript
{
  user_hash: string,
  event_name: string,       // 'first_use', 'consent_given', 'message_sent', 'transaction_confirmed', 'debt_created', etc.
  event_data: object,
  timestamp: Date
}
```

### Rate Limits Collection
```javascript
{
  _id: string,              // "{hashedPhone}:{angolaDate}" — composite key
  count: number,
  notified: boolean,
  resetAt: Date              // TTL index auto-deletes expired entries
}
```

## Database Index Management

**IMPORTANT**: Index names are auto-generated by MongoDB. When modifying indexes:

1. **Never create the same index twice** — MongoDB throws `IndexKeySpecsConflict` (code 86)
2. **Check existing indexes before adding new ones**
3. **Handle index conflicts gracefully** — Use try-catch with error code 86

Current Indexes:
- `transactions`: `{ user_hash: 1, date: -1 }`, `{ message_sid: 1 }` (unique)
- `debts`: `{ user_hash: 1, settled: 1 }`, `{ user_hash: 1, creditor: 1, debtor: 1 }`, `{ user_hash: 1, creditor_lower: 1 }`, `{ user_hash: 1, debtor_lower: 1 }`, `{ message_sid: 1 }` (unique)
- `sessions`: `{ phone_hash: 1 }` (unique), `{ updatedAt: 1 }` (TTL 1800s)
- `events`: `{ event_name: 1, timestamp: -1 }`, `{ user_hash: 1, timestamp: -1 }`, `{ timestamp: 1 }` (partial TTL on `data_deleted` — 2 year retention)
- `rate_limits`: `{ resetAt: 1 }` (TTL auto-delete)
- `broadcast_list`: `{ user_hash: 1 }` (unique)
- `_migrations`: no special indexes

## Cost Optimization

Regex parser handles ~90% of standard messages for free. OpenAI called only when regex returns `ambiguous`. Response cache (~50% hit rate) further reduces calls. Effective OpenAI cost: < $0.01/user/month.

## Deployment

- `railway.toml` configures health check at `/health` with 300s timeout
- Port binds before MongoDB connection (prevents Railway container kills)
- `serverReady` flag returns 503 until all startup completes
- CI: GitHub Actions runs all tests on push to main and on PRs (Node 20/22)