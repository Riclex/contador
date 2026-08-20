# Contador — Traction Investment Plan & Implementation

> **PRIVATE.** Gitignored. Companion to STRATEGY.md, RUNWAY.md, LAUNCH-STATUS.md
> and 90-day-plan.md. This document turns the acquisition budget into a concrete,
> step-by-step build + spend plan, and specs the referral/incentive flow that the
> budget pays out through.
>
> Last updated: 2026-08-20 · Launch window: 2026-10-06 (LOCKED)

---

## 0. The one-line thesis

> **The binding constraint is not money — it is the boots-on-the-ground person.**
> Spend concentrates on the human channel and on data-credit incentives that
> reward *real, verifiable* behavior (interviews, referrals, graph-building),
> never on paying people to "use" the product. Paid ads stay off until the
> on-site phase validates messaging.

### Why not "pay 50 users to use it for a month"

- Your decision gates (D7 ≥ 60%, ≥3 msgs/7 days, conversion ≥ 40%) are built on
  *organic* retention. A paid-to-show-up user fabricates all of them — you would
  decide to "escalar" on metrics that don't exist in the real product.
- In a scam-cautious market, "we'll pay you to use this" reads as *burla*, not
  trust. It is the opposite of your trust moat.
- It teaches you nothing. Real signal comes from people who use it because the
  fiado ledger is genuinely better than the notebook.

**What you pay for instead:** research (interviews), referrals (word-of-mouth),
and graph-building milestones — all in **data/airtime credit**, never cash.

---

## 1. Investment tiers (Kz; ~835 Kz/USD)

Spend is **gated by your own decision criteria** (Escalar / Perseverar / Pivotar
from LAUNCH-STATUS.md and 90-day-plan.md). Do not spend Tier 2 unless the gates
pass.

### Tier 0 — Lean validation (Oct window), ~55.000 Kz (~$65)
Funds the 2026-10-06 launch as planned. Validates the funnel, nothing more.

| Item | Kz | Notes |
|------|----|-------|
| On-site materials (flyers, one-pager w/ QR to WhatsApp number) | 5.000–8.000 | Viana, Rangel, Kilamba |
| Data-credit incentives (first 10–15 interviews + 50 early adopters) | 10.000–15.000 | Airtime/data, not cash |
| Reserved radio spot test | ~10.000 | Only if interviews show radio reach |
| Buffer / misc | ~15.000 | Unforeseen |

### Tier 1 — Proper traction (the number to commit to), ~180–220K (~$250)
This is where the needle moves. **Concentrate here.**

| Item | Kz | Notes |
|------|----|-------|
| **Boots-on-the-ground outreach hire, 6–8 wks part-time, fixed contract** | **120–150K** | THE blocker. One person who already knows the vendor communities beats all ads. |
| Data-credit incentive pool (early adopters + referrals) | 30–40K | Paid out through the `/indicar` flow (Section 3) |
| Materials + association/leader partnerships | ~10K | The trusted channel |
| Facebook Ads A/B test (optional, for channel data) | 15–20K | Both persona ads already drafted in 90-day-plan.md |

**Model against your own CAC:** 220K → ~400–500 active users ≈ 440–550 Kz/user,
above your 200 Kz CAC target. Treat the first cohorts as **research/data**, not
cheap acquisition. Only once the funnel is proven (a known contact→active rate)
does paid acquisition become the cheap channel.

### Tier 2 — Scale (only after validation passes, ~Nov), ~400–500K (~$550+)
Only if Perseverar/Escalurar gates pass (D7 ≥ 40–60%, conversion ≥ 20–40%).
Then: radio spot, bigger referral program, second outreach hire, ad spend on the
channel that won. **If the gates fail, stop — do not spend Tier 2 on a product
people won't retain.**

### Discipline rules
- **No paid ads before the Oct–Nov on-site phase.** You have no validated
  messaging; you'd buy impressions against copy nobody tested, in a market where
  trust is earned face-to-face. The 90-day plan already sequences ads to Week 5–6.
- **The hire is the single highest-ROI line item.** If you can fund only one
  thing, it is that — not Facebook, not radio.
- **Respect RUNWAY.md triggers.** Spend the acquisition budget only while in the
  green zone (≥9 months runway); freeze discretionary spend the moment runway
  drops below ~6 months.

---

## 2. Step-by-step implementation

### Phase A — Pre-launch build (now → 2026-10-06)

**A1. Ship the referral/incentive flow (Section 3).** This is the mechanism the
budget pays out through. Build `/indicar` + the incentive-confirmation flow +
the `referrals` collection + admin `/referidos` view.

**A2. Wire the incentive ledger.** Decide the credit amounts (Section 3.1) and
make them configurable via env vars so you can tune without redeploying.

**A3. Finalize the interview script.** Already drafted in 90-day-plan.md (Semana
2) and recruitment-message.md. Convert the "15 min/week feedback" ask into a
**paid** engagement: 5.000 Kz data credit per completed interview.

**A4. Set up the metrics tracker.** Google Sheets per early-adopter-tracker.md;
confirm `scripts/metrics-daily.js` runs clean. Add a `referrals` tab.

**A5. Secure the hire.** Fixed contract, 6–8 weeks, part-time, starting the week
of 2026-10-06. Deliverable-based: N interviews, N early adopters recruited, N
referrals activated. This is the item that slipped twice — lock it first.

**A6. Fresh-eyes onboarding test.** Run the full consent → first transaction →
`hoje` flow on a clean number. Fix anything that breaks.

### Phase B — On-site acquisition (2026-10-06 → ~mid-Nov)

**B1. Week 1–2 (6–19 Oct):** List 30 contacts (vendors, cantineiros, family);
schedule 5–10 in-person interviews; complete 5. Pay the interview credit.

**B2. Week 3–4 (20 Oct – 2 Nov):** Complete 10 interviews; compile insights;
refine messaging; collect 3–5 testimonials. Activate the referral flow — each
early adopter gets a `/indicar` prompt and a credit for each vendor they bring in
who logs ≥3 transactions.

**B3. Week 5–6 (3–16 Nov):** Channel test. WhatsApp Status 3×/week, association
partnerships, and — only now — the Facebook A/B test (both ads from 90-day-plan).

**B4. Week 7–8 (17–30 Nov):** Price validation survey (250/500/1000 Kz) to the
early-adopter cohort; analyze; decide premium scope. **Do not build premium
features before this WTP signal** (STRATEGY.md).

### Phase C — Decision (end of Nov)

Run the Escalar/Perseverar/Pivotar gates on real data. If Escalar → release Tier
2. If Perseverar → optimize product + messaging, no new spend. If Pivotar →
rethink product or audience, stop spend.

---

## 3. Referral & incentive flow — spec

### 3.1 Incentive design (data/airtime credit, never cash)

| Behavior | Credit | Verification |
|----------|--------|--------------|
| Completed 15-min interview | 5.000 Kz | Interview logged by outreach person |
| Referral activates (logs ≥3 transactions in first 7 days) | 2.000 Kz to referrer | `referrals` record + transaction count |
| Referral becomes active (≥3 msgs in a 7-day window) | 2.000 Kz to referrer | Same, later window |
| First 5 fiados logged (graph-building) | 1.000 Kz | `debts` count |

Credits are **airtime/data top-ups**, delivered manually by the outreach person
or via a small top-up partner. No cash, no payment requests inside WhatsApp —
this preserves the "never ask for money" trust line.

### 3.2 New command: `/indicar <nome> <telefone>`

**Purpose:** lets a user refer a vendor by name + phone. The bot records the
referral and, when the referred number first activates, credits the referrer.

**Flow:**
1. User sends `/indicar Maria +2449xxxxxxxx`.
2. Bot validates the phone (reuse `isValidWhatsAppPhone`), stores a pending
   referral, and replies: *"Obrigado! Quando a Maria começar a usar, ganhas
   saldo de dados. Manda o número do Contador para ela: [link]."*
3. When the referred phone first sends a message (first `first_use` event), the
   bot matches it against pending referrals and marks it `activated`.
4. After the referred user logs ≥3 transactions, the referrer's credit is
   marked `earned` and queued for payout.

**Data model — `referrals` collection:**
```javascript
{
  referrer_hash: string,     // SHA-256 of referrer phone
  referred_hash: string,     // SHA-256 of referred phone (raw phone never stored)
  name: string,              // max 50 chars
  status: "pending" | "activated" | "earned" | "paid",
  created_at: Date,
  activated_at: Date|null,
  earned_at: Date|null,
  paid_at: Date|null
}
```

**Anti-abuse:**
- One pending referral per referred phone (unique index on `referred_hash`).
- A user cannot refer themselves (reject if `referred_hash === referrer_hash`).
- Credit only on *verified* activation (≥3 transactions), not on signup.
- Cap pending referrals per referrer (e.g. 10) to prevent spam.

### 3.3 New admin command: `/referidos`

Lists pending/activated/earned referrals with counts, so the outreach person
and you can see the funnel and trigger payouts. Admin-only, like `/stats`.

### 3.4 Implementation checklist (files to touch)

- `lib/security.js` — add `AWAITING_REFERRAL_NAME` / `AWAITING_REFERRAL_PHONE`
  session states (or a single `AWAITING_REFERRAL` state with a two-step prompt).
- `lib/handlers/commands.js` — add `handleIndicar`, `handleReferidos`; register
  `/indicar` in `COMMANDS`, `EXACT_COMMANDS`/`REGEX_COMMANDS`.
- `lib/handlers/session.js` — add the referral state handler(s).
- `lib/webhook.js` — on `first_use`, check for a pending referral and mark
  `activated`; wire the new state handlers into the dispatch switch.
- `index.js` — create the `referrals` collection + unique index on
  `referred_hash`; add `referrals` to the `deps` object and to `/apagar` deletion
  (referral records are user data — must be deletable).
- `lib/metrics.js` — optionally add `referralsCreated` / `referralsActivated` to
  daily metrics.
- `docs/PRIVACY.md` + `/privacidade` — disclose that referral data (name + phone
  of the referred person) is stored, and that it is deleted on `/apagar`.

**Tests:** unit tests for phone validation, self-referral rejection, and the
activation/earned transitions; integration test for the full `/indicar` →
activation → credit flow.

---

## 4. Budget ledger (fill as you spend)

| Date | Item | Kz | Tier | Status |
|------|------|----|------|--------|
| | | | | |

---

## 5. Alternative names for evaluation

Some users didn't like "Contador" (it can read as "accountant" / formal, or
clash with the word for a counting device). Options below, grouped by angle.
All are short, WhatsApp-friendly, and Angola-localized. **Test 2–3 with the
early-adopter cohort before committing** — the name is a trust signal, not a
brand exercise.

### Local / Kimbundu-flavored (strongest differentiation)
| Name | Meaning / angle | Why it works |
|------|-----------------|--------------|
| **Kilapi** | Kimbundu for "debt / fiado" | Already a command; instantly signals the fiado use-case; unmistakably Angolan. |
| **Kixikila** | Kimbundu for "small / little" | Warm, humble, familiar — "the little helper." |
| **Mukanda** | Kimbundu for "book / letter" | "Your digital notebook" — maps to the caderno it replaces. |
| **Nzola** | Kimbundu for "desire / want" | Short, memorable, positive. |

### Descriptive / benefit-led (clear, low-risk)
| Name | Angle | Why it works |
|------|-------|--------------|
| **Meu Caderno** | "My notebook" | Directly replaces the caderno de fiado; zero explanation needed. |
| **Fiado** | The word itself | If the core pain is fiados, own the word. |
| **Saldo** | "Balance" | Signals the `hoje`/balance value instantly. |
| **Kumbu** | Kimbundu for "account / count" | Short, local, finance-adjacent. |

### Modern / friendly
| Name | Angle | Why it works |
|------|-------|--------------|
| **Conta Fácil** | "Easy account" | Benefit-led, approachable, low-literacy friendly. |
| **Meu Kwanza** | "My kwanza" | Owns the currency; personal + financial. |
| **Zungueiro** | Street vendor (Luanda) | If you want to own the vendor identity explicitly. |

### Recommendation
- **Top pick: Kilapi.** It is already a live command, it names the exact pain
  (fiados), and it is unambiguously Angolan — the strongest trust + recall combo.
- **Runner-up: Meu Caderno** for the older "Comerciante Estabelecido" persona who
  needs the "replaces my notebook" framing spelled out.
- Consider a **dual-name** approach: brand as *Kilapi* but keep the tagline
  "o teu caderno de fiado no WhatsApp" so both personas recognize it.

> Note: renaming touches every user-facing string (welcome, `/ajuda`, `/termos`,
> `/privacidade`, `/anunciar` prefix, PITCH.md, marketing.md, the privacy/terms
> pages, and the WhatsApp display name). Budget ~1–2 days of copy + a
> find-replace pass if you switch. Do it **before** the Oct 6 launch, not after.
