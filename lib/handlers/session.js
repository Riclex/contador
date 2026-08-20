import logger from '../logger.js';
import crypto from 'crypto';
import { SessionState, isAffirmative, isNegative, isValidDebtName, formatKz, MAX_AMOUNT, hashPhone } from '../security.js';
import { createReferral, normalizeReferralPhone, extractPhoneFromText, maybeEarnReferral, referralSuccessMessage, REFERRAL_STATUS, scrubReferredPerson, isValidReferralName } from '../referrals.js';

// --- Shared confirmation handler pattern ---
// Eliminates 4x repetition of the same affirmation/negation/reset flow.
async function handleConfirmation(ctx, { validate, onConfirm, onCancel }) {
  if (isAffirmative(ctx.text)) {
    if (validate) {
      const result = validate(ctx);
      if (!result || typeof result === 'string') {
        ctx.markSessionDirty();
        ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
        await ctx.saveSessionIfDirty();
        await ctx.reply(typeof result === 'string' ? result : "Erro interno. Tenta novamente.");
        return;
      }
    }
    try {
      await onConfirm(ctx);
    } catch (err) {
      if (err.code !== 11000) throw err;
      // Duplicate key = already recorded, continue
    }
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else if (isNegative(ctx.text)) {
    if (onCancel) await onCancel(ctx);
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}

function isValidAmount(amount) {
  return Number.isFinite(Number(amount)) && Number(amount) > 0 && Number(amount) <= MAX_AMOUNT;
}

// --- Session State Handlers ---

export async function handleAwaitingConfirmation(ctx) {
  await handleConfirmation(ctx, {
    validate: (ctx) => {
      const p = ctx.session.pending;
      if (!p) return false;
      if (!isValidAmount(p.amount)) return "Valor inválido. Tenta novamente.";
      return true;
    },
    onConfirm: async (ctx) => {
      const p = ctx.session.pending;
      await ctx.transactions.insertOne({
        message_sid: ctx.messageSid,
        user_hash: ctx.userHash,
        type: p.type,
        amount: Number(p.amount),
        description: p.description,
        date: new Date()
      });
      await ctx.logEvent('transaction_confirmed', { type: p.type });
      // If this user was referred, check whether they've now earned the referrer credit.
      // Gated on the existence of a pending/activated referral so the vast majority of users
      // (never referred) pay only one cheap indexed findOne per confirmation instead of an
      // unbounded countDocuments over all their transactions.
      try {
        if (ctx.referrals) {
          const active = await ctx.referrals.findOne(
            { referred_hash: ctx.userHash, status: { $in: [REFERRAL_STATUS.PENDING, REFERRAL_STATUS.ACTIVATED] } },
            { projection: { _id: 1 } }
          );
          if (active) {
            const count = await ctx.transactions.countDocuments({ user_hash: ctx.userHash });
            await maybeEarnReferral(ctx.referrals, ctx.userHash, count);
          }
        }
      } catch (err) {
        logger.error(err, '[REFERRAL] maybeEarnReferral error');
      }
      await ctx.replyWithRetry("Registado.");
    },
    onCancel: async (ctx) => {
      await ctx.reply("Cancelado.");
    }
  });
}

export async function handleAwaitingDebtConfirmation(ctx) {
  await handleConfirmation(ctx, {
    validate: (ctx) => {
      const p = ctx.session.pendingDebt;
      if (!p) return false;
      if (!isValidAmount(p.amount)) return "Valor inválido. Tenta novamente.";
      return true;
    },
    onConfirm: async (ctx) => {
      const p = ctx.session.pendingDebt;
      await ctx.debts.insertOne({
        message_sid: ctx.messageSid,
        user_hash: ctx.userHash,
        type: p.type,
        creditor: p.creditor,
        debtor: p.debtor,
        creditor_lower: p.creditor.toLowerCase(),
        debtor_lower: p.debtor.toLowerCase(),
        amount: Number(p.amount),
        description: p.description,
        date: new Date(),
        settled: false,
        settled_date: null
      });
      await ctx.logEvent('debt_created', { type: p.type });
      await ctx.replyWithRetry("Dívida registada.");
    },
    onCancel: async (ctx) => {
      await ctx.reply("Cancelado.");
    }
  });
}

export async function handleAwaitingPagoConfirm(ctx) {
  await handleConfirmation(ctx, {
    validate: (ctx) => {
      const p = ctx.session.pendingPago;
      return p && p.debtId;
    },
    onConfirm: async (ctx) => {
      const p = ctx.session.pendingPago;
      await ctx.debts.updateOne(
        { _id: p.debtId, user_hash: ctx.userHash },
        { $set: { settled: true, settled_date: new Date() } }
      );
      const who = p.type === "recebido" ? `${p.debtor} te deve` : `tu deves a ${p.creditor}`;
      await ctx.replyWithRetry(`Dívida de ${who} ${formatKz(p.amount)} Kz marcada como paga.`);

      // Check for remaining debts with same name
      const nameLower = p.name.toLowerCase();
      const escapedName = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameRegex = new RegExp(`^${escapedName}`);
      const remaining = await ctx.debts.countDocuments({
        user_hash: ctx.userHash,
        settled: { $ne: true },
        _id: { $ne: p.debtId },
        $or: [{ creditor_lower: nameRegex }, { debtor_lower: nameRegex }]
      });
      if (remaining > 0) {
        await ctx.reply(`Mais ${remaining} dívida(s) com este nome. Manda /pago ${p.name} de novo.`);
      }
    },
    onCancel: async (ctx) => {
      await ctx.reply("Operação cancelada.");
    }
  });
}

export async function handleAwaitingDebtorName(ctx) {
  const text = ctx.text;
  const pendingDebt = ctx.session.pendingDebt;

  if (isNegative(text)) {
    await ctx.reply("Cancelado.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }

  // Guard against corrupted session
  if (!pendingDebt || typeof pendingDebt.amount !== 'number') {
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    await ctx.reply("Erro interno. Tenta novamente.");
    return;
  }

  // Update the name based on debt type
  const name = text.trim();

  // Validate name: max 30 chars, letters/accented chars/spaces only, no commands
  if (name.length === 0 || name.length > 30 || !/^[a-zA-ZÀ-ÿ\s]+$/.test(name)) {
    await ctx.reply("Nome inválido. Usa só letras e espaços (máximo 30 caracteres).");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }

  // Reject reserved confirmation keywords as debt names (e.g., "sim", "nao")
  if (!isValidDebtName(name)) {
    await ctx.reply("Nome inválido. Usa só letras e espaços (máximo 30 caracteres).");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }

  // For "recebido" (someone owes user): debtor="user" (unknown), need debtor name
  if (pendingDebt.type === "recebido" && pendingDebt.debtor === "user") {
    pendingDebt.debtor = name;
  // For "devido" (user owes someone): creditor="user" (unknown), need creditor name
  } else if (pendingDebt.type === "devido" && pendingDebt.creditor === "user") {
    pendingDebt.creditor = name;
  } else {
    logger.error({ type: pendingDebt.type, debtor: pendingDebt.debtor, creditor: pendingDebt.creditor }, '[SESSION] AWAITING_DEBTOR_NAME reached with invalid state');
    await ctx.reply("Erro interno. Tenta novamente.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }

  const amount = Number(pendingDebt.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    logger.error({ amount: pendingDebt.amount, type: pendingDebt.type }, '[SESSION] AWAITING_DEBTOR_NAME invalid amount');
    await ctx.reply("Valor inválido. Tenta novamente.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }

  // Go to confirmation instead of inserting directly (consistent with other flows)
  ctx.markSessionDirty();
  ctx.sessions.set(ctx.sessionKey, {
    state: SessionState.AWAITING_DEBT_CONFIRMATION,
    pendingDebt: pendingDebt
  });
  await ctx.saveSessionIfDirty();
  const who = pendingDebt.type === "recebido" ? `${name} te deve` : `tu deves a ${name}`;
  await ctx.reply(`Registar que ${who} ${formatKz(pendingDebt.amount)} Kz?\nResponde: Sim ou Não`);
}

export async function handleAwaitingApagarConfirm(ctx) {
  const text = ctx.text;

  if (isAffirmative(text)) {
    // Record erasure intent first — if process crashes mid-deletion, this proves the request existed
    const auditId = crypto.randomUUID();
    await ctx.events.insertOne({
      _id: auditId,
      event_name: 'data_deletion_started',
      timestamp: new Date()
    });

    try {
      let deleteCounts = { transactions: 0, debts: 0, events: 0 };

      if (ctx.transactionsSupported) {
        // Delete all user data atomically via MongoDB transaction (requires replica set)
        const clientSession = ctx.mongoClient.startSession();
        try {
          await clientSession.withTransaction(async () => {
            const dt = await ctx.transactions.deleteMany({ user_hash: ctx.userHash }, { session: clientSession });
            const dd = await ctx.debts.deleteMany({ user_hash: ctx.userHash }, { session: clientSession });
            const de = await ctx.events.deleteMany({ user_hash: ctx.userHash }, { session: clientSession });
            await ctx.db.collection('sessions').deleteOne({ phone_hash: hashPhone(ctx.from) }, { session: clientSession });
            await ctx.db.collection('onboarding').deleteOne({ user_hash: ctx.userHash }, { session: clientSession });
            await ctx.db.collection('broadcast_list').deleteOne({ user_hash: ctx.userHash }, { session: clientSession });
            await ctx.db.collection('feedback').deleteMany({ user_hash: ctx.userHash }, { session: clientSession });
            // Referral data: delete records where this user is the referrer (their own
            // referral data), and scrub records where they are the referred person — the
            // referrer keeps their earned credit, but the referred person's hash/name are
            // removed so their data doesn't survive their own /apagar.
            if (ctx.referrals) {
              await ctx.referrals.deleteMany({ referrer_hash: ctx.userHash }, { session: clientSession });
              await scrubReferredPerson(ctx.referrals, ctx.userHash, { session: clientSession });
            }
            // Delete rate_limits using hashed key (consistent with other collections)
            const normalizedPhone = hashPhone(ctx.from);
            await ctx.rateLimits.deleteMany({
              _id: { $gte: `${normalizedPhone}:`, $lt: `${normalizedPhone}:￿` }
            }, { session: clientSession });
            deleteCounts = {
              transactions: dt.deletedCount,
              debts: dd.deletedCount,
              events: de.deletedCount
            };
          });
        } finally {
          await clientSession.endSession();
        }
      } else {
        // Sequential deletion fallback for standalone MongoDB (no replica set)
        const dt = await ctx.transactions.deleteMany({ user_hash: ctx.userHash });
        const dd = await ctx.debts.deleteMany({ user_hash: ctx.userHash });
        const de = await ctx.events.deleteMany({ user_hash: ctx.userHash });
        await ctx.db.collection('sessions').deleteOne({ phone_hash: hashPhone(ctx.from) });
        await ctx.db.collection('onboarding').deleteOne({ user_hash: ctx.userHash });
        await ctx.db.collection('broadcast_list').deleteOne({ user_hash: ctx.userHash });
        await ctx.db.collection('feedback').deleteMany({ user_hash: ctx.userHash });
        if (ctx.referrals) {
          await ctx.referrals.deleteMany({ referrer_hash: ctx.userHash });
          await scrubReferredPerson(ctx.referrals, ctx.userHash);
        }
        const normalizedPhone = hashPhone(ctx.from);
        await ctx.rateLimits.deleteMany({
          _id: { $gte: `${normalizedPhone}:`, $lt: `${normalizedPhone}:￿` }
        });
        deleteCounts = {
          transactions: dt.deletedCount,
          debts: dd.deletedCount,
          events: de.deletedCount
        };
      }

      // Replace the intent record with a completion record
      await ctx.events.updateOne(
        { _id: auditId },
        {
          $set: {
            event_name: 'data_deleted',
            metadata: {
              transactions_deleted: deleteCounts.transactions,
              debts_deleted: deleteCounts.debts,
              events_deleted: deleteCounts.events
            }
          }
        }
      );

      await ctx.replyWithRetry("✅ Todos os teus dados foram apagados permanentemente.");
      ctx.sessions.delete(ctx.sessionKey);
    } catch (error) {
      logger.error(error, '[/APAGAR] Error during deletion');
      await ctx.reply("Erro ao apagar dados. Tenta novamente mais tarde.");
      ctx.markSessionDirty();
      ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
      await ctx.saveSessionIfDirty();
    }
  } else if (isNegative(text)) {
    await ctx.reply("Operação cancelada. Os teus dados permanecem armazenados.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}

export async function handleAwaitingDesfazerConfirm(ctx) {
  await handleConfirmation(ctx, {
    validate: (ctx) => {
      const p = ctx.session.pendingDesfazer;
      return p && p.id;
    },
    onConfirm: async (ctx) => {
      const p = ctx.session.pendingDesfazer;
      try {
        if (p.type === 'transaction') {
          await ctx.transactions.deleteOne({ _id: p.id, user_hash: ctx.userHash });
          await ctx.logEvent('transaction_undone', { type: p.type });
        } else if (p.type === 'debt') {
          await ctx.debts.deleteOne({ _id: p.id, user_hash: ctx.userHash });
          await ctx.logEvent('debt_undone', { type: p.type });
        } else if (p.type === 'debt_reopen') {
          // Undo a /pago: reopen the debt instead of deleting it.
          await ctx.debts.updateOne(
            { _id: p.id, user_hash: ctx.userHash },
            { $set: { settled: false, settled_date: null } }
          );
          await ctx.logEvent('debt_reopened', { type: 'debt_reopen' });
        }
        const doneMsg = p.type === 'debt_reopen'
          ? "✅ Desfeito! Dívida reaberta (marcada como não paga)."
          : "✅ Desfeito! Último registo apagado.";
        await ctx.replyWithRetry(doneMsg);
      } catch (err) {
        logger.error(err, '[/DESFAZER] Error deleting');
        await ctx.reply("Erro ao desfazer. Tenta novamente mais tarde.");
      }
    },
    onCancel: async (ctx) => {
      await ctx.reply("Operação cancelada.");
    }
  });
}

// /indicar two-step flow — step 1: capture the referred person's name.
export async function handleAwaitingReferralName(ctx) {
  // Preserve original casing for the referred person's name (normalized `ctx.text` is lowercased).
  const text = (ctx.rawText || ctx.text).trim();
  if (isNegative(text)) {
    await ctx.reply("Operação cancelada.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }
  if (!isValidReferralName(text)) {
    await ctx.reply("Nome inválido. Usa só letras e espaços (máximo 50 caracteres).");
    return;
  }
  ctx.markSessionDirty();
  ctx.sessions.set(ctx.sessionKey, {
    state: SessionState.AWAITING_REFERRAL_PHONE,
    pendingReferral: { name: text }
  });
  await ctx.saveSessionIfDirty();
  await ctx.reply(`Nome: ${text}\n\nAgora escreve o número de WhatsApp da pessoa (com o código 244). Exemplo: 244912345678`);
}

// /indicar two-step flow — step 2: capture the referred person's phone, then store.
export async function handleAwaitingReferralPhone(ctx) {
  const text = ctx.text.trim();
  const pending = ctx.session.pendingReferral;
  if (isNegative(text)) {
    await ctx.reply("Operação cancelada.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }
  if (!pending || !pending.name) {
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    await ctx.reply("Erro interno. Tenta novamente.");
    return;
  }
  const phoneToken = extractPhoneFromText(text);
  const phone = phoneToken ? normalizeReferralPhone(phoneToken) : null;
  if (!phone) {
    await ctx.reply("Número inválido. Escreve o número com o código 244. Exemplo: 244912345678");
    return;
  }
  const result = await createReferral(ctx.referrals, {
    referrerHash: ctx.userHash,
    referredPhone: phone,
    name: pending.name
  });
  if (!result.ok) {
    if (result.reason === 'self') {
      await ctx.reply("Não podes indicar-te a ti mesmo. 😄");
    } else if (result.reason === 'duplicate') {
      await ctx.reply("Esta pessoa já foi indicada.");
    } else if (result.reason === 'limit') {
      await ctx.reply("Já tens muitas indicações pendentes. Espera que algumas sejam pagas antes de indicar mais.");
    } else {
      await ctx.reply("Erro ao guardar a indicação. Tenta novamente.");
    }
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }
  await ctx.logEvent('referral_created', { referred_hash: result.referredHash });
  ctx.markSessionDirty();
  ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
  await ctx.saveSessionIfDirty();
  await ctx.reply(referralSuccessMessage(pending.name));
}
