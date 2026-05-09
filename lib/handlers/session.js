import crypto from 'crypto';
import { SessionState, isAffirmative, isNegative, isValidDebtName, formatKz, MAX_AMOUNT, hashPhone } from '../security.js';

// --- Session State Handlers ---

export async function handleAwaitingConfirmation(ctx) {
  const text = ctx.text;

  if (isAffirmative(text)) {
    // Guard against corrupted session (missing pending data)
    if (!ctx.session.pending || typeof ctx.session.pending.amount !== 'number') {
      ctx.markSessionDirty();
      ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
      await ctx.saveSessionIfDirty();
      await ctx.reply("Erro interno. Tenta novamente.");
      return;
    }
    const amount = Number(ctx.session.pending.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      await ctx.reply("Valor inválido. Tenta novamente.");
      ctx.markSessionDirty();
      ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
      await ctx.saveSessionIfDirty();
      return;
    }
    try {
      await ctx.transactions.insertOne({
        message_sid: ctx.messageSid,
        user_hash: ctx.userHash,
        type: ctx.session.pending.type,
        amount: amount,
        description: ctx.session.pending.description,
        date: new Date()
      });
      await ctx.logEvent('transaction_confirmed', { type: ctx.session.pending.type });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
    await ctx.replyWithRetry("Registado.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else if (isNegative(text)) {
    await ctx.reply("Cancelado.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}

export async function handleAwaitingDebtConfirmation(ctx) {
  const text = ctx.text;

  if (isAffirmative(text)) {
    // Guard against corrupted session (missing pendingDebt data)
    if (!ctx.session.pendingDebt || typeof ctx.session.pendingDebt.amount !== 'number') {
      ctx.markSessionDirty();
      ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
      await ctx.saveSessionIfDirty();
      await ctx.reply("Erro interno. Tenta novamente.");
      return;
    }
    const amount = Number(ctx.session.pendingDebt.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      await ctx.reply("Valor inválido. Tenta novamente.");
      ctx.markSessionDirty();
      ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
      await ctx.saveSessionIfDirty();
      return;
    }
    try {
      await ctx.debts.insertOne({
        message_sid: ctx.messageSid,
        user_hash: ctx.userHash,
        type: ctx.session.pendingDebt.type,
        creditor: ctx.session.pendingDebt.creditor,
        debtor: ctx.session.pendingDebt.debtor,
        creditor_lower: ctx.session.pendingDebt.creditor.toLowerCase(),
        debtor_lower: ctx.session.pendingDebt.debtor.toLowerCase(),
        amount: amount,
        description: ctx.session.pendingDebt.description,
        date: new Date(),
        settled: false,
        settled_date: null
      });
      await ctx.logEvent('debt_created', { type: ctx.session.pendingDebt.type });
      await ctx.replyWithRetry("Dívida registada.");
    } catch (e) {
      if (e.code !== 11000) throw e;
      // Duplicate key = already recorded by a previous request, no action needed
    }
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else if (isNegative(text)) {
    await ctx.reply("Cancelado.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}

export async function handleAwaitingPagoConfirm(ctx) {
  const text = ctx.text;

  if (isAffirmative(text)) {
    // Guard against corrupted session (missing pendingPago data)
    if (!ctx.session.pendingPago || !ctx.session.pendingPago.debtId) {
      ctx.markSessionDirty();
      ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
      await ctx.saveSessionIfDirty();
      await ctx.reply("Erro interno. Tenta novamente.");
      return;
    }
    await ctx.debts.updateOne(
      { _id: ctx.session.pendingPago.debtId, user_hash: ctx.userHash },
      { $set: { settled: true, settled_date: new Date() } }
    );
    const p = ctx.session.pendingPago;
    const who = p.type === "recebido" ? `${p.debtor} te deve` : `tu deves a ${p.creditor}`;
    await ctx.replyWithRetry(`Dívida de ${who} ${formatKz(p.amount)} Kz marcada como paga.`);

    // Check for remaining debts with same name (prefix match)
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
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else if (isNegative(text)) {
    await ctx.reply("Operação cancelada.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
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
    console.error(`[SESSION] AWAITING_DEBTOR_NAME reached with invalid state: type=${pendingDebt.type}, debtor=${pendingDebt.debtor}, creditor=${pendingDebt.creditor}`);
    await ctx.reply("Erro interno. Tenta novamente.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
    return;
  }

  const amount = Number(pendingDebt.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    console.error(`[SESSION] AWAITING_DEBTOR_NAME invalid amount ${pendingDebt.amount} for ${pendingDebt.type} debt`);
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
    // Use a double-hash so the audit record cannot be linked back to the original phone number
    const auditId = crypto.randomUUID();
    const auditHash = hashPhone(ctx.userHash); // one-way anonymized key
    await ctx.events.insertOne({
      _id: auditId,
      event_name: 'data_deletion_started',
      audit_hash: auditHash,
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
      console.error('[/APAGAR] Error during deletion:', error.message);
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
  const text = ctx.text;

  if (isAffirmative(text)) {
    // Guard against corrupted session (missing pendingDesfazer data)
    if (!ctx.session.pendingDesfazer || !ctx.session.pendingDesfazer.id) {
      ctx.markSessionDirty();
      ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
      await ctx.saveSessionIfDirty();
      await ctx.reply("Erro interno. Tenta novamente.");
      return;
    }
    const pendingDesfazer = ctx.session.pendingDesfazer;
    try {
      if (pendingDesfazer.type === 'transaction') {
        await ctx.transactions.deleteOne({ _id: pendingDesfazer.id, user_hash: ctx.userHash });
        await ctx.logEvent('transaction_undone', { type: pendingDesfazer.type });
      } else if (pendingDesfazer.type === 'debt') {
        await ctx.debts.deleteOne({ _id: pendingDesfazer.id, user_hash: ctx.userHash });
        await ctx.logEvent('debt_undone', { type: pendingDesfazer.type });
      }
      await ctx.replyWithRetry("✅ Desfeito! Último registo apagado.");
    } catch (err) {
      console.error('[/DESFAZER] Error deleting:', err.message);
      await ctx.reply("Erro ao desfazer. Tenta novamente mais tarde.");
    }
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else if (isNegative(text)) {
    await ctx.reply("Operação cancelada.");
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.IDLE });
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}
