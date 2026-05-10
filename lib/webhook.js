import logger from './logger.js';
import { COMMANDS, EXACT_COMMANDS, REGEX_COMMANDS } from './handlers/commands.js';

// Webhook handler factory — receives all dependencies from index.js
// and returns the Express route handler for POST /webhook.
//
// Mutable state (serverReady, mongoConnected) is NOT destructured —
// it is read via deps.serverReady / deps.mongoConnected so that
// runtime changes (e.g. MongoDB reconnect) are reflected live.

export function createWebhookHandler(deps) {
  return async (req, res) => {
    // Destructure immutable deps (captured once after startup)
    const {
      db, transactions, debts, events, rateLimits, dailyMetrics,
      sessions, processingUsers, processedMessages, MAX_PROCESSED_MESSAGES,
      SESSION_TTL_MS, ADMIN_NUMBERS, TWILIO_WHATSAPP_NUMBER,
      mongo, transactionsSupported,
      checkRateLimit, reply, replyWithRetry, logEvent,
      getOnboardingState, setOnboardingState, sendWelcomeMessage,
      getSession, setSession,
      stateHandlers, parseHandlers,
      parseTransaction, parseDebt,
      getEnhancedStats, getRetentionData,
      computeDailyMetrics, getOrCreateSnapshot, getRecentSnapshots,
      twilioClient, twilio,
      hashPhone, sanitizeInput, normalize,
      isAffirmative, isConfirmationWord, SessionState, OnboardingState,
      logEventFailures,
    } = deps;

    const { handleAwaitingConfirmation, handleAwaitingDebtConfirmation, handleAwaitingPagoConfirm, handleAwaitingDebtorName, handleAwaitingApagarConfirm, handleAwaitingDesfazerConfirm } = stateHandlers;
    const { handleDebtParse, handleTransactionParse } = parseHandlers;

    // --- Mutable state: read live from deps (not destructured) ---
    if (!deps.serverReady) return res.sendStatus(503);
    if (!deps.mongoConnected) return res.sendStatus(503);

    // Webhook timeout — Twilio times out at ~15s; fail fast if we can't respond in time
    const WEBHOOK_TIMEOUT_MS = 12000;
    const webhookTimeout = setTimeout(() => {
      if (!res.headersSent) {
        logger.error('[WEBHOOK] Request timed out after 12s');
        res.status(504).send('Gateway Timeout');
      }
    }, WEBHOOK_TIMEOUT_MS);
    res.on('finish', () => clearTimeout(webhookTimeout));

    // Webhook Signature Verification (Sprint 9 — Security)
    // Skipped in test mode (NODE_ENV=test) to allow integration testing without Twilio credentials
    const reqId = Math.random().toString(36).substring(2, 8);
    req.reqId = reqId;

    if (process.env.NODE_ENV !== 'test') {
      const twilioSignature = req.headers['x-twilio-signature'];
      if (!twilioSignature) {
        logger.error({ reqId, ip: req.ip }, '[WEBHOOK] Missing signature header');
        return res.status(401).send('Missing signature');
      }

      // WEBHOOK_URL preferred for reliable signature verification; falls back to header-based URL
      const url = process.env.WEBHOOK_URL || `${req.protocol}://${req.get('host')}/webhook`;

      // Use Twilio's official validateRequest function
      const isValid = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        twilioSignature,
        url,
        req.body  // Parsed body object
      );

      if (!isValid) {
        logger.error({ reqId, ip: req.ip }, '[WEBHOOK] Invalid webhook signature');
        logger.error({ reqId, url }, '[WEBHOOK] Signature verification URL');
        return res.status(401).send('Invalid signature');
      }

      logger.info({ reqId }, '[WEBHOOK] Signature verified successfully');
    }

    const from = req.body.From;
    const rawText = req.body.Body || "";
    const userHash = hashPhone(from);

    // Input sanitization
    const text = normalize(sanitizeInput(rawText));
    const messageSid = req.body.MessageSid;

    // Prevent concurrent processing of the same user (race condition on session state)
    if (processingUsers.has(userHash)) return res.sendStatus(204);
    processingUsers.add(userHash);
    const userLockTimer = setTimeout(() => processingUsers.delete(userHash), 30000);

    try {
    // Rate limiting — check before logging events to avoid inflating stats
    const rateLimit = await checkRateLimit(from);
    if (!rateLimit.allowed) {
      if (rateLimit.sendNotice) {
        await reply(from, `Limite diário de mensagens atingido. Tente novamente amanhã.`);
      }
      return res.sendStatus(204);
    }

    // Parallelize: check onboarding state and load session simultaneously
    const [onboardingState, mongoSession] = await Promise.all([
      getOnboardingState(from),
      getSession(db, deps.mongoConnected, from)
    ]);

    // Handle consent flow (short-circuits for non-consenting users)
    if (onboardingState === OnboardingState.AWAITING_CONSENT) {
      if (isAffirmative(text)) {
        await logEvent('first_use', from, { source: 'whatsapp' });
        await logEvent('consent_given', from, {});
        await setOnboardingState(from, OnboardingState.COMPLETED);
        await replyWithRetry(from, `Perfeito! Podes começar a usar o Contador.

  Experimenta mandar algo como:
  • "vendi 5000 de pão"
  • "comprei 1000 de saldo"
  • "hoje" (para ver o saldo)`);
        return res.sendStatus(204);
      } else {
        await replyWithRetry(from, `Preciso do teu consentimento para guardar os dados. Responde "sim" para continuar.`);
        return res.sendStatus(204);
      }
    }

    // Check if this is a new user (onboardingState is null when no record exists)
    if (onboardingState === null) {
      await setOnboardingState(from, OnboardingState.AWAITING_CONSENT);
      await sendWelcomeMessage(from);
      return res.sendStatus(204);
    }

    // Log message_sent event (after consent check — only for consenting users)
    await logEvent('message_sent', from, { message_length: rawText.length, message_type: 'inbound' });

    // Retry protection
    if (!messageSid) {
      return res.sendStatus(204);
    }

    if (processedMessages.has(messageSid)) {
      return res.sendStatus(204);
    }

    processedMessages.add(messageSid);

    while (processedMessages.size > MAX_PROCESSED_MESSAGES) {
      const first = processedMessages.values().next().value;
      processedMessages.delete(first);
    }

    // Load session (already fetched in parallel above)
    const sessionKey = hashPhone(from); // Use hash as key — raw phone numbers never stored in memory
    let session = sessions.get(sessionKey);
    let sessionDirty = false; // Track whether session state changed (reduces MongoDB writes)

    function markSessionDirty() {
      sessionDirty = true;
    }

    async function saveSessionIfDirty() {
      if (sessionDirty) {
        try {
          const result = await setSession(db, deps.mongoConnected, from, sessions.get(sessionKey));
          if (result.modifiedCount === 0 && result.upsertedCount === 0) {
            // Version conflict — reload from MongoDB and retry once
            logger.warn('[SESSION] Version conflict detected, reloading session');
            const fresh = await getSession(db, deps.mongoConnected, from);
            sessions.set(sessionKey, fresh || { state: SessionState.IDLE, updatedAt: new Date() });
            // Retry save with fresh version
            const retryResult = await setSession(db, deps.mongoConnected, from, sessions.get(sessionKey));
            if (retryResult.modifiedCount === 0 && retryResult.upsertedCount === 0) {
              logger.error('[SESSION] Failed to save session after retry');
              return;
            }
          }
          sessionDirty = false;
        } catch (err) {
          logger.error(err, '[SESSION] Failed to save session to MongoDB');
          // Keep sessionDirty = true so next request retries the write
        }
      }
    }
    if (session && session.updatedAt && Date.now() - new Date(session.updatedAt).getTime() > SESSION_TTL_MS) {
      sessions.delete(sessionKey);
      session = null;
    }
    if (!session) {
      session = mongoSession || { state: SessionState.IDLE, updatedAt: new Date() };
      sessions.set(sessionKey, { ...session }); // Clone to avoid shared reference
    } else {
      // Clone in-memory session to prevent concurrent handlers from sharing state
      session = { ...session };
      sessions.set(sessionKey, session);
    }

    // Reset session if user typed a command during an active confirmation flow
    if (session.state !== SessionState.IDLE && !isConfirmationWord(text)) {
      const isCommand = COMMANDS.has(text) || /^\/\w+\s+/.test(text);
      if (isCommand) {
        await reply(from, "Operação cancelada.");
        markSessionDirty(); sessions.set(sessionKey, { state: SessionState.IDLE });
        await saveSessionIfDirty();
        session = sessions.get(sessionKey);
      }
    }

    // --- Construct context for command/state handlers ---
    const ctx = {
      from,
      text,
      userHash,
      messageSid,
      sessionKey,
      session,
      sessions,
      db,
      transactions,
      debts,
      events,
      rateLimits,
      mongoClient: mongo,
      transactionsSupported,
      reply: (body) => reply(from, body),
      replyWithRetry: (body) => replyWithRetry(from, body),
      logEvent: (eventName, metadata) => logEvent(eventName, from, metadata),
      markSessionDirty,
      saveSessionIfDirty,
      parseTransaction,
      parseDebt,
      adminNumbers: ADMIN_NUMBERS,
      getEnhancedStats,
      getRetentionData,
      dailyMetrics,
      computeDailyMetrics: () => computeDailyMetrics(events, transactions, debts),
      getOrCreateSnapshot: (date) => getOrCreateSnapshot(dailyMetrics, events, transactions, debts, date),
      getRecentSnapshots: (days) => getRecentSnapshots(dailyMetrics, events, transactions, debts, days),
      sendWhatsApp: async (to, body) => {
        await twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, body });
      },
    };

    // --- Command dispatch via handler maps ---
    const exactHandler = EXACT_COMMANDS.get(text);
    if (exactHandler) {
      await exactHandler(ctx);
      return res.sendStatus(204);
    }

    for (const route of REGEX_COMMANDS) {
      const match = text.match(route.pattern);
      if (match) {
        await route.handler(ctx, match);
        return res.sendStatus(204);
      }
    }

    // --- Session state dispatch ---
    switch (session.state) {

    case SessionState.AWAITING_CONFIRMATION:
      await handleAwaitingConfirmation(ctx);
      return res.sendStatus(204);

    case SessionState.AWAITING_DEBT_CONFIRMATION:
      await handleAwaitingDebtConfirmation(ctx);
      return res.sendStatus(204);

    case SessionState.AWAITING_PAGO_CONFIRM:
      await handleAwaitingPagoConfirm(ctx);
      return res.sendStatus(204);

    case SessionState.AWAITING_DEBTOR_NAME:
      await handleAwaitingDebtorName(ctx);
      return res.sendStatus(204);

    case SessionState.AWAITING_APAGAR_CONFIRM:
      await handleAwaitingApagarConfirm(ctx);
      return res.sendStatus(204);

    case SessionState.AWAITING_DESFAZER_CONFIRM:
      await handleAwaitingDesfazerConfirm(ctx);
      return res.sendStatus(204);

    case SessionState.IDLE:
    default: {
      // Safety: catch unexpected state values and reset to IDLE
      if (session.state !== SessionState.IDLE) {
        logger.warn({ state: session.state }, '[SESSION] Unexpected state, resetting to IDLE');
        markSessionDirty(); sessions.set(sessionKey, { state: SessionState.IDLE });
        await saveSessionIfDirty();
      }
      // Try debt parsing first, then transaction parsing
      const debtHandled = await handleDebtParse(ctx);
      if (!debtHandled) {
        await handleTransactionParse(ctx);
      }
      return res.sendStatus(204);
    }
    }
    } finally {
      clearTimeout(userLockTimer);
      processingUsers.delete(userHash);
    }

  };
}
