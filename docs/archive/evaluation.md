# Project Analysis & Evaluation Report

> Generated: 2026-05-09 | Updated: 2026-05-10 | Scope: Full codebase evaluation, architecture, security, performance

## Executive Summary

**Contador** is a WhatsApp-based finance tracking MVP designed for the Angolan market. It allows users to record income, expenses, and debts via natural language messages in Portuguese. The codebase has undergone significant modular refactoring since the initial evaluation in March 2026.

---

## Project Metrics

| Metric | Value |
|--------|-------|
| **Entry point** | ~882 lines (`index.js`) |
| **Lib modules** | 13 files, ~2,900 lines total |
| **Total Commits** | 90 |
| **Dependencies** | 10 (Express, MongoDB, OpenAI, Twilio, body-parser, dotenv, helmet, express-rate-limit, zod, pino) |
| **Architecture** | Modular Express.js with extracted lib modules |
| **Test Files** | 15 (8 unit, 7 integration) |
| **Target Market** | Angola (Portuguese, Kwanza currency) |

---

## Architecture Evaluation

### Strengths

| Aspect | Implementation | Rating |
|--------|---------------|--------|
| **Hybrid Parsing** | Regex first (~90% free), OpenAI fallback | ⭐⭐⭐⭐⭐ |
| **Response Caching** | LRU cache (1000 entries, 24h TTL) | ⭐⭐⭐⭐⭐ |
| **Security** | Webhook signature verification (SHA256), rate limiting (50/day), Helmet headers | ⭐⭐⭐⭐⭐ |
| **Session Management** | MongoDB-backed with in-memory Map, LRU eviction (10k max), optimistic locking | ⭐⭐⭐⭐ |
| **Modular Architecture** | `lib/session.js`, `lib/openai.js`, `lib/handlers/*.js` extracted | ⭐⭐⭐⭐ |
| **Structured Logging** | Pino with log levels, JSON in production, pretty in dev | ⭐⭐⭐⭐⭐ |
| **Cost Control** | GPT-4o-mini only, daily cap (500 calls), ~50% cache hit rate | ⭐⭐⭐⭐⭐ |
| **Deduplication** | MessageSid tracking + MongoDB unique indexes, FIFO eviction (10k limit) | ⭐⭐⭐⭐ |
| **Input Validation** | Zod middleware for webhook body, schema validators for OpenAI responses, debt name validation, amount bounds | ⭐⭐⭐⭐⭐ |

### Weaknesses

| Aspect | Concern | Severity |
|--------|---------|----------|
| **In-memory caches reset on restart** | Sessions, response cache, OpenAI counters all in-memory | Low |

---

## Code Quality Assessment

### Positives
- Modular architecture with clear domain separation (handlers, parsers, cache, security)
- Hybrid regex/OpenAI parsing with caching reduces API costs by ~95%
- ReDoS protection in regex patterns (non-catastrophic patterns)
- Environment validation at startup with helpful error messages
- Proper error handling for OpenAI failures, MongoDB disconnects, and Twilio retries
- Duplicate key handling (code 11000) for idempotent message processing
- Graceful shutdown with MongoDB connection cleanup
- ESLint configured (flat config, ESLint 10)
- Session optimistic locking with version field prevents concurrent-write corruption

### Technical Debt

| Priority | Item | Status |
|----------|------|--------|
| **High** | Modular refactoring (session, OpenAI, handlers extracted to `lib/`) | ✅ Done |
| **High** | Webhook handler extraction (~380 lines in index.js) | ✅ Done |
| **Medium** | Input validation schema (Zod/Joi) | ✅ Done |
| **Medium** | Session state value normalization (mixed case across states) | ✅ Done |
| **Low** | Structured logging (Winston/Pino) | ✅ Done |
| **Low** | TypeScript migration | Future (architectural direction, not active debt) |

---

## Security Review

### Implemented ✅
- Webhook signature verification (SHA256) via Twilio's `validateRequest`
- Rate limiting — per-user (50/day, MongoDB-backed) + per-IP (100/min, express-rate-limit)
- Input sanitization (control character, zero-width, and directional override stripping)
- Message deduplication (MessageSid tracking + MongoDB unique indexes)
- Admin-only `/stats`, `/metricas`, `/retencao`, `/anunciar` authorization
- OpenAI prompt injection filtering (6 injection patterns blocked)
- OpenAI response schema validation (field types, length caps, extra key stripping)
- Amount validation at both parse time and confirmation time
- Helmet HTTP security headers (CSP, X-Frame-Options, etc.)
- PII isolation: `broadcast_list` separates phone numbers from onboarding state
- Audit trail: `data_deletion_started` events prove erasure requests
- TTL indexes: events auto-deleted (1 year general, 2 years for `data_deleted`, 7 days for markers)
- Phone validation order: `isValidWhatsAppPhone` runs before `hashPhone` to prevent crash on missing/empty `From`
- `logEvent` non-silent fallback — failures counted and exposed in `/health` and `/stats`

### Gaps 🟡
- No CAPTCHA or abuse prevention beyond rate limiting
- In-memory caches (sessions, dedup set, response cache) reset on restart

---

## Sprint Status

### Completed Sprints
| Sprint | Status | Key Deliverables |
|--------|--------|------------------|
| Sprint 1: Cost Optimization | ✅ | Regex parser, GPT-4o-mini, LRU cache, deduplication |
| Sprint 2: Business Features | ✅ | Debt system, `/mes`, `/resumo` commands |
| Sprint 3: UX & Onboarding | ✅ | Confirmation flow, `/ajuda`, onboarding with consent (awaiting_consent → completed) |
| Sprint 4: Privacy & Compliance | ✅ | Phone hashing, `/meusdados`, `/apagar`, consent flow, broadcast_list PII isolation |
| Sprint 5: Reports & Export | ✅ | `/mes`, `/resumo`, `/exportar` (JSON + text), `/meusdados` |
| Sprint 9: Security & Stability | ✅ | Webhook verification, rate limiting, MongoDB retry, Helmet |
| Sprint 10: Privacy (Lei 22/11) | ✅ | Data portability, TTL indexes, deletion audit trail, privacy/terms commands |
| Sprint 11: Admin Analytics | ✅ | `/stats`, `/metricas` (7-day trends), `/retencao` (cohorts), `/anunciar` broadcast |
| Sprint 12: Data Portability | ✅ | `/exportar`, `/meusdados`, `/apagar` (atomic with transactions) |

### Pending/Next
| Sprint | Status | Key Items |
|--------|--------|-----------|
| Sprint 6: White-Label B2B | Not started | Multi-tenant support |
| Sprint 13: Voice Commands | Not started | Audio transcription for low literacy |
| Sprint 14: Batch Input | Not started | Multi-line transaction parsing |

---

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Cache hit rate | ~50% | Based on repeated messages |
| OpenAI API usage | ~10% | Regex handles 90% of messages |
| Response time (cache hit) | <100ms | |
| Response time (OpenAI) | ~500-800ms | 15s timeout, 3 consecutive failure threshold |
| Memory usage | Bounded | LRU cache (1000), dedup set (10k), sessions Map (10k), all with eviction |
| Cost per message | ~$0.001-0.005 | Optimized with regex + cache |
| OpenAI daily cap | 500 calls | Safety valve, resets at Angola midnight |

---

## Test Coverage

| Suite | Type | Tests | Status |
|-------|------|-------|--------|
| `test/cache.test.js` | Unit | 6 | ✅ |
| `test/consent.test.js` | Unit | 10 | ✅ |
| `test/metrics.test.js` | Unit | 3 | ✅ |
| `test/parsers.test.js` | Unit | ~30 | ✅ |
| `test/parsers-emprestei.test.js` | Unit | 4 | ✅ |
| `test/security.test.js` | Unit | ~35 | ✅ |
| `test/smoke.test.js` | Unit | 1 | ✅ |
| `test/webhook.test.js` | Unit | ~45 | ✅ |
| `test/integration/onboarding.test.js` | Integration | 12 | ✅ |
| `test/integration/webhook-e2e.test.js` | Integration | 14 | ✅ |
| `test/integration/transaction.test.js` | Integration | 5 | ✅ |
| `test/integration/debt.test.js` | Integration | 6 | ✅ |
| `test/integration/commands.test.js` | Integration | 5 | ✅ |
| `test/integration/session.test.js` | Integration | 3 | ✅ |
| `test/integration/rate-limit.test.js` | Integration | 3 | ✅ |

---

## Market Position

### Target Personas
1. **"Vendedora Estudante"** (25yo, informal seller + student)
2. **"Comerciante Estabelecido"** (45-60yo, cantina/shop owner)

### Competitive Advantages
- Zero friction (no app download, uses WhatsApp)
- Localized for Angola (Kz, "fiado", Portuguese terms)
- Cost-optimized (regex first, cache, GPT-4o-mini)
- Trust via familiarity (WhatsApp platform)
- Lei 22/11 compliant (data portability, deletion, TTL-based retention)

### Competitors
| Competitor | Advantage Over |
|------------|---------------|
| Physical notebooks | Cloud backup, calculations, reminders |
| International apps (Mint, QuickBooks) | Price, localization, no bank account needed |
| Excel/Sheets | Mobile-first, zero configuration |

---

## Recommendations

### Completed Since March 2026
1. ✅ **Modular refactoring** — Extracted `lib/openai.js`, `lib/session.js`, `lib/handlers/*.js`
2. ✅ **ESLint configuration** — Flat config for ESLint 10
3. ✅ **Events TTL** — 1-year auto-delete for non-critical events
4. ✅ **Webhook e2e tests** — 14 integration tests covering full request lifecycle
5. ✅ **Onboarding integration tests** — 12 tests replacing placeholders
6. ✅ **Session cache eviction** — Map-based with 10k max + LRU eviction
7. ✅ **Null-guards** — All session state handlers guard against corrupted sessions
8. ✅ **Stats cache TTL** — Reduced to 1 minute for fresher admin data
9. ✅ **Phone validation order fix** — `hashPhone(undefined)` crash prevented by validating `From` before hashing
10. ✅ **Extract webhook handler** — `lib/webhook.js` factory function with explicit deps, ~380 lines removed from `index.js`
11. ✅ **`logEvent` non-silent fallback** — `logEventFailures` counter exposed in `/health` and `/stats`, `[AUDIT-TRAIL-GAP]` prefix on error
12. ✅ **Normalize session state values** — `OnboardingState` now uppercase (`AWAITING_CONSENT`, `COMPLETED`), backward-compatible helper for old documents
13. ✅ **Zod input validation schema** — `lib/schemas.js` with `WebhookBodySchema`, middleware validates `From`, `Body`, and `MessageSid` before handler entry
14. ✅ **Pino structured logging** — Replaced 75 `console.*` calls across 6 production files with `logger.info/error/warn`, JSON output in production, pretty print in dev

### Immediate (Next)
_All identified technical debt from March 2026 evaluation resolved. TypeScript migration remains a future architectural direction, not active debt._

### Short-term
1. **Horizontal scaling preparation** — Move session cache and dedup set to Redis

### Long-term
1. **TypeScript migration** — Type safety for growing codebase
2. **Voice command support** — GPT-4o Transcribe for low-literacy users
3. **B2B partnerships** — White-label for banks/microfinance

---

## Overall Rating

| Category | Mar 2026 | May 2026 | Notes |
|----------|----------|----------|-------|
| **Functionality** | 9/10 | 9/10 | Core features + admin analytics, data export, broadcast |
| **Code Quality** | 7/10 | 9/10 | Modular refactoring, ESLint, Zod validation, Pino logging, improved test coverage |
| **Security** | 8/10 | 8/10 | Solid baseline, no critical gaps |
| **Scalability** | 6/10 | 7/10 | Sessions cache eviction added, some in-memory state remains |
| **Maintainability** | 6/10 | 9/10 | Clear module boundaries, domain-specific handler files, structured logging, schema validation |
| **Market Fit** | 8/10 | 8/10 | Well-positioned for Angola |
| **Cost Efficiency** | 9/10 | 9/10 | Smart optimizations in place |

### Overall: 8.4/10 (up from 7.6)

**Verdict:** Production-ready MVP with solid security, cost optimizations, modular architecture, structured logging, schema validation, and full Lei 22/11 privacy compliance. Ready for launch in Angola's informal economy. All identified technical debt from the March 2026 evaluation has been resolved.

---

## File Structure

```
contador/
├── index.js                     # Main application (~882 lines)
├── lib/
│   ├── cache.js                 # LRU response cache + OpenAI tracking
│   ├── commands.js              # Barrel file (re-exports from handlers/)
│   ├── handlers/
│   │   ├── commands.js          # 21 user/admin command handlers (~895 lines)
│   │   ├── parsers.js           # 2 fall-through parsers (debt, transaction)
│   │   └── session.js           # 6 session state handlers (~367 lines)
│   ├── logger.js                # Pino structured logging (JSON prod, pretty dev)
│   ├── metrics.js               # Daily metrics aggregation
│   ├── openai.js                # OpenAI client + health check + parse pipeline
│   ├── parsers.js               # Regex-based parsers + normalization
│   ├── schemas.js               # Zod input validation schemas
│   ├── security.js              # Hashing, sanitization, validation, enums
│   ├── session.js               # Session CRUD + in-memory Map cache
│   └── webhook.js               # Webhook handler factory (~400 lines, extracted from index.js)
├── test/
│   ├── cache.test.js, consent.test.js, metrics.test.js, ...
│   ├── parsers.test.js, parsers-emprestei.test.js, ...
│   ├── security.test.js, smoke.test.js, webhook.test.js
│   └── integration/
│       ├── commands.test.js, debt.test.js, onboarding.test.js
│       ├── rate-limit.test.js, session.test.js
│       ├── transaction.test.js, webhook-e2e.test.js
├── package.json
├── eslint.config.js             # ESLint flat config
├── CLAUDE.md                    # Development guidelines
├── Ideas.md                     # Product roadmap & sprints
├── evaluation.md                # This file
└── .env                         # Environment variables (not tracked)
```

---

## Key Technical Decisions

### 1. Hybrid Parsing Strategy
**Decision:** Regex first, OpenAI fallback
- **Rationale:** Cost optimization - regex handles ~90% of messages for free
- **Impact:** Reduced API costs by ~95%, daily safety cap of 500 OpenAI calls
- **Caching:** LRU cache with ~50% hit rate further reduces calls

### 2. Modular Refactoring (Post-MVP)
**Decision:** Extract lib modules from monolithic index.js
- **Rationale:** Maintainability, testability, clear separation of concerns
- **Modules created:** `openai.js`, `session.js`, `handlers/commands.js`, `handlers/session.js`, `handlers/parsers.js`
- **Completed:** Webhook handler extracted to `lib/webhook.js` (~400 lines) in May 2026

### 3. MongoDB Native Driver
**Decision:** Use native driver instead of Mongoose
- **Rationale:** Lower overhead, more control over aggregations
- **Trade-off:** Manual schema validation (implemented in `lib/security.js`)

### 4. Session Persistence with Memory Cache
**Decision:** MongoDB-backed sessions with in-memory Map cache, LRU eviction (10k max)
- **Rationale:** Survive restarts while maintaining speed, prevent memory leaks
- **Concurrency:** Optimistic locking with version field, dirty-flag reduces writes

### 5. Lei 22/11 Data Protection
**Decision:** Phone hashing, TTL-based retention, audit trail for deletion
- **Impact:** PII isolated in `broadcast_list`, events auto-expire, deletion creates provable audit records
- **Dual-TTL:** `data_deleted` events kept 2 years, other events kept 1 year, markers expire in 7 days

---

## Cost Analysis

### Monthly Operating Costs (Estimated)

| Component | Volume | Cost |
|-----------|--------|------|
| Twilio WhatsApp | 1,000 messages | ~$15-30 |
| OpenAI GPT-4o-mini | ~50 requests | ~$0.25-1 |
| MongoDB Atlas | M10 cluster | ~$15-30 |
| Railway hosting | 1 instance | ~$5-10 |
| **Total** | | **~$35-70/month** |

### Cost Optimizations Implemented
- Regex parser for standard patterns (90% of messages)
- LRU cache for repeated messages (~50% hit rate)
- GPT-4o-mini only (no expensive models)
- Message deduplication (prevents double processing)
- Daily OpenAI call cap (500 calls safety valve)

---

*Report generated by Claude Code. Last updated: 2026-05-10*
