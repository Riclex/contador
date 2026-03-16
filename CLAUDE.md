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
- **Session Management**: MongoDB-backed with in-memory cache - sessions persist across restarts with 30min TTL
- **Deduplication**: `processedMessages` Set tracks `MessageSid` values with a 10,000 message FIFO limit to prevent memory leaks
- **Response Cache**: LRU cache (1000 entries, 24h TTL) for parsed results to avoid reprocessing identical messages
- **Rate Limiting**: Per-user daily limit (50 messages/day) to prevent abuse
- **Admin Commands**: `/stats` command for authorized phone numbers shows cache hit rate and performance metrics
- **User Commands**: `/mes` (monthly summary), `/resumo` (7-day summary), `/ajuda` (help menu), `/termos` (terms of use), `/privacidade` (privacy policy)
- **Privacy Commands**: `/meusdados` (view user data), `/apagar` (delete all data - right to be forgotten)

### Security Features

- **ReDoS Protection**: Safe regex patterns prevent catastrophic backtracking attacks
- **Input Validation**: Amount values validated for range and type before processing
- **Webhook Signature Verification**: SHA256 signature validation via `x-twilio-signature` header
- **Input Sanitization**: Control characters stripped from user messages
- **OpenAI Error Handling**: API failures handled gracefully with user-friendly error messages
- **Graceful Shutdown**: MongoDB connection properly closed on SIGTERM/SIGINT
- **Rate Limiting**: Per-user daily limit (50 messages) prevents API abuse

### Key Components

1. **Webhook Handler** (`POST /webhook`): Receives WhatsApp messages via Twilio
   - Message deduplication using `MessageSid` (returns 204 for duplicates)
   - Parses incoming messages normalized to lowercase
   - Handles commands: `hoje`, `/quemedeve`, `/quemdevo`, `/kilapi`, `/pago <name>`, `/stats` (admin only), `/mes`, `/resumo`, `/ajuda`, `/meusdados`, `/apagar`, `/privacidade`, `/termos`
   - Manages multiple session states: `IDLE`, `AWAITING_CONSENT`, `ONBOARDING_COMPLETE`, `AWAITING_CONFIRMATION`, `AWAITING_DEBT_CONFIRMATION`, `AWAITING_DEBTOR_NAME`

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

5. **Confirmation Flow**: Parsed transactions and debts require user confirmation (sim/nao) before database insertion

6. **Response Cache** (`getCachedResponse`, `setCachedResponse`): LRU cache implementation
   - Caches parsed results by message text + parser type (transaction/debt)
   - 1000 entry limit with LRU eviction
   - 24-hour TTL for cache entries
   - Cache statistics via `/stats` admin command

7. **Database Indexes**:
   - `transactions`: `{ user_phone: 1, date: -1 }` for date range queries, `{ message_sid: 1 }` unique
   - `debts`: `{ user_phone: 1, settled: 1 }`, `{ user_phone: 1, creditor: 1, debtor: 1 }`, `{ message_sid: 1 }` unique
   - `events`: `{ user_hash: 1, timestamp: -1 }` for user activity queries

### Sprint 9 - Completed (Security & Stability)
- **Webhook Signature Verification**: SHA256 validation of Twilio signatures
- **Input Sanitization**: Control character stripping before processing
- **Rate Limiting**: 50 messages/user/day with automatic cleanup
- **MongoDB Connection Retry**: Exponential backoff with 10 retries
- **Session Persistence**: MongoDB-backed sessions with 30min TTL

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

Admin phone numbers (from env with fallback):
- `whatsapp:+244912756717`
- `whatsapp:+351936123127`

## Testing

```bash
# Run debt parser tests
node test-debt-parser.js

# Run cache tests
node test-cache.js
node test-cache-integration.js
node test-cache-direct.js

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
- `GET /health` - Health check endpoint returns "ok"

## Data Model

### Events Collection (Audit Log)
```javascript
{
  user_hash: string,         // SHA-256 hash of phone number (privacy compliance)
  event_name: string,        // e.g., 'first_use', 'consent_given', 'message_sent', 'transaction_confirmed'
  event_data: object,        // Event-specific data
  timestamp: Date            // When event occurred
}
```

### Transactions Collection
```javascript
{
  message_sid: string,     // Twilio MessageSid for deduplication
  user_phone: string,      // Note: migrated to user_hash in events collection
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
  user_phone: string,         // Note: migrated to user_hash in events collection
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
   - `transactions`: `{ user_phone: 1, date: -1 }`, `{ message_sid: 1 }` (unique)
   - `debts`: `{ user_phone: 1, settled: 1 }`, `{ user_phone: 1, creditor: 1, debtor: 1 }`, `{ message_sid: 1 }` (unique)

## Security Considerations

- **ReDoS Protection**: Amount extraction regex uses non-catastrophic pattern `/(\d[\d\s]*?)\s*(?:kz|paus)?$/i`
- **Input Validation**: Amount values checked for `Number.isFinite()`, positive values, and max limit (1B)
- **Error Handling**: OpenAI API failures return service unavailable error without exposing stack traces
- **Logging**: Sensitive transaction data removed from console logs
- **Graceful Shutdown**: MongoDB connection closed properly on server termination

## Cost Optimization

The regex parser handles ~90% of standard messages (e.g., "vendi 1000 Kz de fuba", "comprei pão") for free. OpenAI is only called when the regex parser returns `ambiguous`, significantly reducing API costs while maintaining reliability for edge cases.

### Cache Impact

The response cache further reduces costs by storing parsed results for identical messages:
- **Cache hit rate**: ~50% for repeated messages
- **Storage**: In-memory LRU with 1000 entry limit
- **TTL**: 24 hours
- **Monitoring**: `/stats` command shows hit rate, entries, and performance metrics

**Response Caching**: Identical messages are cached for 24 hours, eliminating redundant OpenAI API calls for repeated patterns (e.g., daily "vendi pão" messages). Cache statistics available via `/stats` admin command.
