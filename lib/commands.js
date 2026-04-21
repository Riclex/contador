import crypto from 'crypto';
import { SessionState, OnboardingState, isValidDebtName, formatKz, isAffirmative, isNegative, isConfirmationWord, getAngolaMidnightUTC, ANGOLA_OFFSET_MS, MAX_AMOUNT, hashPhone } from './security.js';
import { parseTransactionRegex, parseDebtRegex } from './parsers.js';
import { getCachedResponse, setCachedResponse } from './cache.js';

// --- Command names (single source of truth for session reset logic) ---
export const COMMANDS = new Set([
  'hoje', '/hoje', '/quemedeve', '/quemdevo', '/kilapi', '/stats', '/retencao', '/anunciar',
  'ajuda', '/ajuda', 'comandos', '/comandos',
  'privacidade', '/privacidade', 'termos', '/termos',
  'meusdados', '/meusdados', 'apagar', '/apagar',
  'resumo', '/resumo', 'mes', '/mes',
  'desfazer', '/desfazer', '/exportar',
  'feedback', '/feedback'
]);

export const MAX_WHATSAPP_CHARS = 1500;

// --- Command Handlers ---

export async function handleHoje(ctx) {
  await ctx.logEvent('command_used', { command: 'hoje' });

  const utcStart = getAngolaMidnightUTC();

  const aggResult = await ctx.transactions.aggregate([
    { $match: { user_hash: ctx.userHash, date: { $gte: utcStart } } },
    { $group: {
      _id: null,
      income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
      expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } }
    }}
  ]).toArray();

  const income = Number(aggResult[0]?.income) || 0;
  const expense = Number(aggResult[0]?.expense) || 0;
  const total = Number.isFinite(income) && Number.isFinite(expense) ? income - expense : 0;

  await ctx.replyWithRetry(`Total de hoje: ${formatKz(total)} Kz`);
}

export async function handleQuemedeve(ctx, page) {
  await ctx.logEvent('command_used', { command: 'quemedeve' });
  page = Math.max(1, page);
  const pageSize = 50;
  const skip = (page - 1) * pageSize;
  const docs = await ctx.debts.find({
    user_hash: ctx.userHash,
    type: "recebido",
    settled: { $ne: true }
  }).sort({ date: -1 }).skip(skip).limit(pageSize).toArray();

  if (docs.length === 0) {
    await ctx.reply(page > 1 ? "Sem mais dívidas nesta página." : "Ninguém te deve dinheiro.");
    return;
  }

  let message = `Quem te deve dinheiro (pág. ${page}):\n`;
  for (const d of docs) {
    const amt = Number(d.amount);
    if (!Number.isFinite(amt)) continue;
    message += `- ${d.debtor}: ${formatKz(amt)} Kz\n`;
  }
  if (docs.length === pageSize) message += `\n(mostrando ${pageSize} por página, /quemedeve ${page + 1} para mais)`;
  if (message.length > MAX_WHATSAPP_CHARS) message = message.substring(0, MAX_WHATSAPP_CHARS);
  await ctx.replyWithRetry(message);
}

export async function handleQuemdevo(ctx, page) {
  await ctx.logEvent('command_used', { command: 'quemdevo' });
  page = Math.max(1, page);
  const pageSize = 50;
  const skip = (page - 1) * pageSize;
  const docs = await ctx.debts.find({
    user_hash: ctx.userHash,
    type: "devido",
    settled: { $ne: true }
  }).sort({ date: -1 }).skip(skip).limit(pageSize).toArray();

  if (docs.length === 0) {
    await ctx.reply(page > 1 ? "Sem mais dívidas nesta página." : "Tu não deves dinheiro a ninguém.");
    return;
  }

  let message = `Tu deves dinheiro a (pág. ${page}):\n`;
  for (const d of docs) {
    const amt = Number(d.amount);
    if (!Number.isFinite(amt)) continue;
    message += `- ${d.creditor}: ${formatKz(amt)} Kz\n`;
  }
  if (docs.length === pageSize) message += `\n(mostrando ${pageSize} por página, /quemdevo ${page + 1} para mais)`;
  if (message.length > MAX_WHATSAPP_CHARS) message = message.substring(0, MAX_WHATSAPP_CHARS);
  await ctx.replyWithRetry(message);
}

export async function handleKilapi(ctx, page) {
  await ctx.logEvent('command_used', { command: 'kilapi' });
  page = Math.max(1, page);
  const pageSize = 50;
  const skip = (page - 1) * pageSize;
  const docs = await ctx.debts.find({
    user_hash: ctx.userHash,
    settled: { $ne: true }
  }).sort({ date: -1 }).skip(skip).limit(pageSize).toArray();

  if (docs.length === 0) {
    await ctx.reply(page > 1 ? "Sem mais dívidas nesta página." : "Não tens dívidas ativas.");
    return;
  }

  let message = `Dívidas ativas (pág. ${page}):\n`;
  for (const d of docs) {
    const amt = Number(d.amount);
    if (!Number.isFinite(amt)) continue;
    if (d.type === "recebido") {
      message += `- ${d.debtor} te deve: ${formatKz(amt)} Kz\n`;
    } else {
      message += `- Tu deves a ${d.creditor}: ${formatKz(amt)} Kz\n`;
    }
  }
  if (docs.length === pageSize) message += `\n(mostrando ${pageSize} por página, /kilapi ${page + 1} para mais)`;
  if (message.length > MAX_WHATSAPP_CHARS) message = message.substring(0, MAX_WHATSAPP_CHARS);
  await ctx.replyWithRetry(message);
}

export async function handlePago(ctx, name) {
  await ctx.logEvent('command_used', { command: 'pago' });

  if (name.length > 50) {
    await ctx.reply("Nome demasiado longo. Usa até 50 caracteres.");
    return;
  }

  // Prefix match on pre-normalized lowercase fields
  const nameLower = name.toLowerCase();
  const escapedName = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRegex = new RegExp(`^${escapedName}`);
  const doc = await ctx.debts.findOne({
    user_hash: ctx.userHash,
    settled: { $ne: true },
    $or: [
      { creditor_lower: nameRegex },
      { debtor_lower: nameRegex }
    ]
  }, { sort: { date: 1 } });

  if (!doc) {
    // Fallback: list active debt counterparties so user can pick the right name
    const activeDebts = await ctx.debts.find({
      user_hash: ctx.userHash,
      settled: { $ne: true }
    }).sort({ date: -1 }).limit(20).toArray();
    if (activeDebts.length === 0) {
      await ctx.reply("Não tens dívidas ativas.");
    } else {
      const names = new Set();
      for (const d of activeDebts) {
        if (d.creditor && d.creditor !== 'user') names.add(d.creditor);
        if (d.debtor && d.debtor !== 'user') names.add(d.debtor);
      }
      const nameList = [...names].slice(0, 10).join(', ');
      await ctx.reply(`Não encontrei esta dívida. Nomes ativos: ${nameList}\nUse /kilapi para ver todas.`);
    }
    return;
  }

  // Count matching debts for disambiguation info
  const totalDebts = await ctx.debts.countDocuments({
    user_hash: ctx.userHash,
    settled: { $ne: true },
    $or: [{ creditor_lower: nameRegex }, { debtor_lower: nameRegex }]
  });
  const extraDebts = totalDebts - 1;

  // Ask for confirmation before settling
  ctx.markSessionDirty();
  ctx.sessions[ctx.sessionKey] = {
    state: SessionState.AWAITING_PAGO_CONFIRM,
    pendingPago: { debtId: doc._id, name, type: doc.type, debtor: doc.debtor, creditor: doc.creditor, amount: doc.amount }
  };
  await ctx.saveSessionIfDirty();
  const who = doc.type === "recebido" ? `${doc.debtor} te deve` : `tu deves a ${doc.creditor}`;
  const suffix = extraDebts > 0 ? ` (mais ${extraDebts} dívida${extraDebts > 1 ? 's' : ''})` : '';
  await ctx.reply(`Marcar como paga: ${who} ${formatKz(doc.amount)} Kz${suffix}?\nResponde: Sim ou Não`);
}

export async function handleStats(ctx) {
  if (ctx.adminNumbers.length === 0) {
    await ctx.reply("Comando desativado.");
    return;
  }
  if (!ctx.adminNumbers.includes(ctx.from)) {
    await ctx.reply("Comando reservado para administradores.");
    return;
  }
  await ctx.logEvent('command_used', { command: 'stats' });
  const stats = await ctx.getEnhancedStats();
  const message = `\u{1F4CA} Contador Stats

Hoje:
\u2022 Novos usuários: ${stats.today.newUsers}
\u2022 Usuários ativos: ${stats.today.activeUsers}
\u2022 Mensagens: ${stats.today.totalMessages}
\u2022 Confirmações: ${stats.today.confirmedTransactions}
\u2022 Dívidas: ${stats.today.debtsCreated}

Cache:
\u2022 Hit rate: ${stats.cache.hitRate}
\u2022 Entries: ${stats.cache.size}

Sistema:
\u2022 Uptime: ${stats.system.uptime}
\u2022 MongoDB: ${stats.system.mongodb}

Ver retenção: /retencao`;
  await ctx.reply(message);
}

export async function handleRetencao(ctx) {
  if (ctx.adminNumbers.length === 0) {
    await ctx.reply("Comando desativado.");
    return;
  }
  if (!ctx.adminNumbers.includes(ctx.from)) {
    await ctx.reply("Comando reservado para administradores.");
    return;
  }
  await ctx.logEvent('command_used', { command: 'retencao' });

  const data = await ctx.getRetentionData();
  if (data.totalUsers === 0) {
    await ctx.reply("Sem dados de retenção ainda.");
    return;
  }

  let message = `\u{1F4C8} Retenção (${data.totalUsers} usuários)\n\nData       | D1   | D7   | D30\n`;

  for (const cohort of data.cohorts.slice(0, 15)) {
    const d1 = cohort.d1 !== null ? `${cohort.d1}%` : '-';
    const d7 = cohort.d7 !== null ? `${cohort.d7}%` : '-';
    const d30 = cohort.d30 !== null ? `${cohort.d30}%` : '-';
    message += `${cohort.date} | ${d1.padStart(4)} | ${d7.padStart(4)} | ${d30.padStart(4)}\n`;
  }

  const safeMessage = message.length > MAX_WHATSAPP_CHARS
    ? message.substring(0, MAX_WHATSAPP_CHARS - 20) + '\n...(continua)'
    : message;
  await ctx.reply(safeMessage);
}

export async function handleAnunciar(ctx) {
  if (ctx.adminNumbers.length === 0) {
    await ctx.reply("Comando desativado.");
    return;
  }
  if (!ctx.adminNumbers.includes(ctx.from)) {
    await ctx.reply("Comando reservado para administradores.");
    return;
  }

  const announcement = ctx.text.replace(/^\/?\s*anunciar\s*/i, '').trim();
  if (!announcement) {
    await ctx.reply("Exemplo: /anunciar Novo comando disponível: /exportar");
    return;
  }
  if (announcement.length > 500) {
    await ctx.reply("Texto muito longo. Máximo 500 caracteres.");
    return;
  }
  await ctx.logEvent('command_used', { command: 'anunciar' });

  // Get all consented users from broadcast_list collection (PII isolated from onboarding)
  const consentedUsers = await ctx.db.collection('broadcast_list').find({}, { projection: { phone: 1 } }).toArray();
  if (consentedUsers.length === 0) {
    await ctx.reply("Nenhum utilizador consentido encontrado.");
    return;
  }

  // Send announcement — respond to admin immediately, then deliver in background batches
  const message = `\u{1F4E2} Anúncio do Contador\n\n${announcement}`;
  const totalUsers = consentedUsers.length;

  // Send first batch synchronously (up to 10 users) to confirm delivery works
  const batchSize = 10;
  const firstBatch = consentedUsers.slice(0, batchSize);
  const remainingUsers = consentedUsers.slice(batchSize);

  let sent = 0;
  let failed = 0;

  for (const user of firstBatch) {
    if (user.phone) {
      try {
        await ctx.sendWhatsApp(user.phone, message);
        sent++;
      } catch { failed++; }
    } else { failed++; }
  }

  // Respond to admin immediately
  if (remainingUsers.length > 0) {
    await ctx.reply(`Anúncio começou: ${sent} enviados de ${totalUsers}. Restantes em entrega.`);
  } else {
    await ctx.reply(`Anúncio enviado: ${sent} utilizadores${failed > 0 ? ` (${failed} falharam)` : ''}`);
  }

  // Deliver remaining users in background (fire-and-forget, won't block webhook)
  if (remainingUsers.length > 0) {
    const bgDelivery = async () => {
      for (let i = 0; i < remainingUsers.length; i += batchSize) {
        const batch = remainingUsers.slice(i, i + batchSize);
        for (const user of batch) {
          if (user.phone) {
            try {
              await ctx.sendWhatsApp(user.phone, message);
              sent++;
            } catch { failed++; }
          } else { failed++; }
        }
        // Twilio WhatsApp rate limit: ~1 msg/sec, pause between batches
        await new Promise(r => setTimeout(r, 1000));
      }
      await ctx.logEvent('announcement_completed', { total: totalUsers, sent, failed });
    };
    bgDelivery().catch(err => console.error('[ANUNCIAR] Background delivery error:', err.message));
  }
}

export async function handleAjuda(ctx) {
  await ctx.logEvent('command_used', { command: 'ajuda' });
  const helpMessage = `\u{1F4DA} Comandos do Contador

\u{1F4CA} SALDO:
\u2022 hoje - Saldo do dia
\u2022 resumo - Últimos 7 dias
\u2022 mes - Este mês

\u{1F4B0} DÍVIDAS:
\u2022 /quemedeve - Quem te deve
\u2022 /quemdevo - A quem deves
\u2022 /kilapi - Todas as dívidas
\u2022 /pago <nome> - Marcar como paga

\u{1F4DD} REGISTRAR:
\u2022 "vendi 1000 de pão" ou "biolo 5000"
\u2022 "comprei 500 kz de saldo" ou "gastei 200 paus"
\u2022 "João me deve 2000" ou "fezada de 3000"
\u2022 "eu devo 1000 a Maria"

\u2190 DESFAZER:
\u2022 /desfazer - Apagar último registo

\u{1F512} PRIVACIDADE:
\u2022 /meusdados - Ver teus dados
\u2022 /exportar - Exportar teus dados
\u2022 /apagar - Apagar tudo
\u2022 /privacidade - Política de privacidade
\u2022 /termos - Termos de uso

\u{1F4AC} FEEDBACK:
\u2022 /feedback <texto> - Enviar sugestão ou reportar problema

\u{1F4A1} Podes responder Sim, Ya, S ou Não, N para confirmar/cancelar.`;
  await ctx.reply(helpMessage);
}

export async function handlePrivacidade(ctx) {
  await ctx.logEvent('command_used', { command: 'privacidade' });
  const privacyMessage = `\u{1F512} PRIVACIDADE

O Contador guarda:
\u2022 Teu número (com hash SHA-256)
\u2022 Transações (vendas, gastos)
\u2022 Dívidas (quem deve, quem deve)

Base legal (Lei 22/11):
\u2022 Consentimento explícito
\u2022 Dados armazenados na UE (Frankfurt/Zurique)

Teus direitos:
\u2022 /meusdados - Ver teus dados
\u2022 /apagar - Apagar tudo

Política completa: https://riclex.github.io/contador/PRIVACY.html`;
  await ctx.reply(privacyMessage);
}

export async function handleTermos(ctx) {
  await ctx.logEvent('command_used', { command: 'termos' });
  const termosMessage = `\u{1F4C4} TERMOS DE USO

O Contador é um assistente financeiro via WhatsApp.

Importante:
\u2022 Serviço "como está" (sem garantias)
\u2022 Tu és responsável pelos dados
\u2022 Não é instituição financeira
\u2022 Limite: 50 mensagens/dia

Preço:
\u2022 Gratuito (fase MVP)

Termos completos: https://riclex.github.io/contador/TERMS.html`;
  await ctx.reply(termosMessage);
}

export async function handleMeusdados(ctx) {
  await ctx.logEvent('command_used', { command: 'meusdados' });

  // Get user data (limit transactions to avoid memory issues)
  const userTransactions = await ctx.transactions.find({ user_hash: ctx.userHash }).sort({ date: -1 }).limit(100).toArray();
  const totalTransactions = await ctx.transactions.countDocuments({ user_hash: ctx.userHash });
  const activeDebts = await ctx.debts.countDocuments({ user_hash: ctx.userHash, settled: { $ne: true } });
  const userEvents = await ctx.events.find({ user_hash: ctx.userHash }, { projection: { event_name: 1, timestamp: 1 } }).sort({ timestamp: -1 }).limit(100).toArray();
  const totalEvents = await ctx.events.countDocuments({ user_hash: ctx.userHash });

  // Aggregate totals from ALL transactions (not just the 100 displayed)
  const [incomeAgg, expenseAgg] = await Promise.all([
    ctx.transactions.aggregate([
      { $match: { user_hash: ctx.userHash, type: 'income' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray(),
    ctx.transactions.aggregate([
      { $match: { user_hash: ctx.userHash, type: 'expense' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray()
  ]);
  const totalIncome = Number.isFinite(incomeAgg[0]?.total) ? incomeAgg[0].total : 0;
  const totalExpenses = Number.isFinite(expenseAgg[0]?.total) ? expenseAgg[0].total : 0;

  const message = `\u{1F4C4} TEUS DADOS

\u{1F464} Usuário: ${(() => { const num = ctx.from.replace('whatsapp:', ''); return '\u2022'.repeat(num.length - 4) + num.slice(-4); })()}

\u{1F4CA} RESUMO:
\u2022 Transações: ${totalTransactions}${totalTransactions > 100 ? ' (últimas 100 mostradas)' : ''}
\u2022 Receitas: ${formatKz(totalIncome)} Kz
\u2022 Despesas: ${formatKz(totalExpenses)} Kz
\u2022 Saldo: ${formatKz(totalIncome - totalExpenses)} Kz
\u2022 Dívidas ativas: ${activeDebts}

\u{1F512} EVENTOS (auditoria):
\u2022 Total: ${totalEvents}${totalEvents > 100 ? ' (últimos 100)' : ''}

Para apagar todos os teus dados: /apagar`;
  const safeMessage = message.length > MAX_WHATSAPP_CHARS
    ? message.substring(0, MAX_WHATSAPP_CHARS)
    : message;
  await ctx.replyWithRetry(safeMessage);
}

export async function handleApagar(ctx) {
  await ctx.logEvent('command_used', { command: 'apagar' });

  // Check if user has data to delete
  const userTransactions = await ctx.transactions.countDocuments({ user_hash: ctx.userHash });
  const userDebts = await ctx.debts.countDocuments({ user_hash: ctx.userHash });
  const userEvents = await ctx.events.countDocuments({ user_hash: ctx.userHash });

  if (userTransactions === 0 && userDebts === 0 && userEvents === 0) {
    await ctx.reply("Não tens dados armazenados para apagar.");
    return;
  }

  // Ask for confirmation
  ctx.markSessionDirty();
  ctx.sessions[ctx.sessionKey] = { state: SessionState.AWAITING_APAGAR_CONFIRM };
  await ctx.saveSessionIfDirty();

  const message = `\u26A0\uFE0F CONFIRMAÇÃO

Tens os seguintes dados armazenados:
\u2022 Transações: ${userTransactions}
\u2022 Dívidas: ${userDebts}
\u2022 Eventos: ${userEvents}

Esta ação é PERMANENTE e não pode ser desfeita.

Responde "sim" para apagar TODOS os teus dados ou "não" para cancelar.`;
  await ctx.reply(message);
}

export async function handleDesfazer(ctx) {
  await ctx.logEvent('command_used', { command: 'desfazer' });

  // Find the most recent record across transactions and debts (including settled debts for /pago undo)
  const lastTransaction = await ctx.transactions.find({ user_hash: ctx.userHash })
    .sort({ date: -1 }).limit(1).toArray();
  const lastDebt = await ctx.debts.find({ user_hash: ctx.userHash })
    .sort({ date: -1 }).limit(1).toArray();

  const txDate = lastTransaction.length > 0 ? lastTransaction[0].date : null;
  const debtDate = lastDebt.length > 0 ? lastDebt[0].date : null;

  if (!txDate && !debtDate) {
    await ctx.reply("Não tens registos para desfazer.");
    return;
  }

  let pendingDesfazer;
  if (!debtDate || (txDate && txDate > debtDate)) {
    const t = lastTransaction[0];
    pendingDesfazer = { type: 'transaction', id: t._id, detail: `${t.type === 'income' ? 'entrada' : 'saída'} de ${formatKz(t.amount)} Kz` };
  } else {
    const d = lastDebt[0];
    const who = d.type === 'recebido' ? `${d.debtor} te deve` : `tu deves a ${d.creditor}`;
    const settledLabel = d.settled ? ' (paga)' : '';
    pendingDesfazer = { type: 'debt', id: d._id, detail: `dívida: ${who} ${formatKz(d.amount)} Kz${settledLabel}` };
  }

  ctx.markSessionDirty();
  ctx.sessions[ctx.sessionKey] = {
    state: SessionState.AWAITING_DESFAZER_CONFIRM,
    pendingDesfazer
  };
  await ctx.saveSessionIfDirty();
  await ctx.reply(`Desfazer o último registo?\n${pendingDesfazer.detail}\nResponde: Sim ou Não`);
}

export async function handleFeedback(ctx) {
  const feedbackText = ctx.text.replace(/^\/?\s*feedback\s*/i, '').trim();
  if (!feedbackText) {
    await ctx.reply("Exemplo: /feedback o bot nao percebeu minha mensagem");
    return;
  }
  await ctx.db.collection('feedback').insertOne({
    user_hash: ctx.userHash,
    text: feedbackText.substring(0, 500),
    date: new Date(),
    message_sid: ctx.messageSid
  });
  await ctx.logEvent('command_used', { command: 'feedback' });
  await ctx.reply("Obrigado pelo feedback! Vamos analisar.");
}

export async function handleExportar(ctx) {
  await ctx.logEvent('command_used', { command: 'exportar' });

  const totalTransactions = await ctx.transactions.countDocuments({ user_hash: ctx.userHash });
  if (totalTransactions === 0) {
    await ctx.reply("Não tens transações para exportar.");
    return;
  }

  // Aggregate full totals (accurate regardless of transaction count)
  const [incomeAgg, expenseAgg, debts] = await Promise.all([
    ctx.transactions.aggregate([
      { $match: { user_hash: ctx.userHash, type: 'income' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]).toArray(),
    ctx.transactions.aggregate([
      { $match: { user_hash: ctx.userHash, type: 'expense' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]).toArray(),
    ctx.debts.find({ user_hash: ctx.userHash, settled: { $ne: true } }).sort({ date: -1 }).limit(50).toArray()
  ]);

  const totalIncome = Number.isFinite(incomeAgg[0]?.total) ? incomeAgg[0].total : 0;
  const incomeCount = incomeAgg[0]?.count || 0;
  const totalExpenses = Number.isFinite(expenseAgg[0]?.total) ? expenseAgg[0].total : 0;
  const expenseCount = expenseAgg[0]?.count || 0;

  let message = `\u{1F4E4} EXPORTAÇÃO DE DADOS

\u{1F4CA} TOTAIS:
\u2022 Entradas: ${formatKz(totalIncome)} Kz (${incomeCount})
\u2022 Saídas: ${formatKz(totalExpenses)} Kz (${expenseCount})
\u2022 Saldo: ${formatKz(totalIncome - totalExpenses)} Kz
\u2022 Transações: ${totalTransactions}`;

  if (debts.length > 0) {
    message += `\n\n\u{1F4B3} DÍVIDAS ATIVAS:`;
    for (const d of debts) {
      const who = d.type === 'recebido' ? `${d.debtor} te deve` : `Tu deves a ${d.creditor}`;
      message += `\n\u2022 ${who}: ${formatKz(d.amount)} Kz`;
    }
  }

  // Show recent transactions (up to message limit)
  const recentTx = await ctx.transactions.find({ user_hash: ctx.userHash }).sort({ date: -1 }).limit(30).toArray();
  if (recentTx.length > 0) {
    message += `\n\n\u{1F4CB} ÚLTIMAS ${recentTx.length} TRANSações:`;
    for (const t of recentTx) {
      const icon = t.type === 'income' ? '\u2b06' : '\u2b07';
      const desc = t.description ? ` - ${t.description}` : '';
      message += `\n${icon} ${formatKz(t.amount)} Kz${desc}`;
    }
  }

  const safeMessage = message.length > MAX_WHATSAPP_CHARS
    ? message.substring(0, MAX_WHATSAPP_CHARS - 20) + '\n...(continua)'
    : message;
  await ctx.replyWithRetry(safeMessage);
}

export async function handleResumo(ctx) {
  await ctx.logEvent('command_used', { command: 'resumo' });

  const sevenDaysAgo = new Date(getAngolaMidnightUTC().getTime() - 7 * 24 * 60 * 60 * 1000);
  const matchStage = { $match: { user_hash: ctx.userHash, date: { $gte: sevenDaysAgo } } };

  const [totalsAgg, dailyAgg] = await Promise.all([
    ctx.transactions.aggregate([
      matchStage,
      { $group: {
        _id: null,
        income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
        expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } }
      }}
    ]).toArray(),
    ctx.transactions.aggregate([
      matchStage,
      { $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: 'Africa/Luanda' } }, type: '$type' },
        total: { $sum: '$amount' }
      }},
      { $group: {
        _id: '$_id.day',
        income: { $sum: { $cond: [{ $eq: ['$_id.type', 'income'] }, '$total', 0] } },
        expense: { $sum: { $cond: [{ $eq: ['$_id.type', 'expense'] }, '$total', 0] } }
      }},
      { $sort: { _id: 1 } }
    ]).toArray()
  ]);

  const income = Number(totalsAgg[0]?.income) || 0;
  const expenses = Number(totalsAgg[0]?.expense) || 0;

  if (!totalsAgg.length || (income === 0 && expenses === 0)) {
    await ctx.reply("Sem transações nos últimos 7 dias.");
    return;
  }

  const balance = Number.isFinite(income) && Number.isFinite(expenses) ? income - expenses : 0;

  let message = `\u{1F4CA} Resumo (Últimos 7 dias)

\u{1F4B0} Entradas: ${formatKz(income)} Kz
\u{1F4B8} Saídas: ${formatKz(expenses)} Kz
\u{1F4C8} Saldo: ${formatKz(balance)} Kz

--- Por dia:`;

  for (const day of dailyAgg) {
    const dayIncome = Number(day.income) || 0;
    const dayExpense = Number(day.expense) || 0;
    const dayBalance = Number.isFinite(dayIncome) && Number.isFinite(dayExpense)
      ? dayIncome - dayExpense : 0;
    const signal = dayBalance >= 0 ? '+' : '';
    const dayDate = new Date(day._id + 'T00:00:00Z');
    const dayStr = dayDate.toLocaleDateString('pt-AO', { weekday: 'short', day: 'numeric' });
    message += `\n${dayStr}: ${signal}${formatKz(dayBalance)} Kz`;
  }

  if (message.length > MAX_WHATSAPP_CHARS) message = message.substring(0, MAX_WHATSAPP_CHARS);
  await ctx.replyWithRetry(message);
}

export async function handleMes(ctx) {
  await ctx.logEvent('command_used', { command: 'mes' });

  const angolaMidnight = getAngolaMidnightUTC();
  // Start of month in Angola time: get Angola date components, build UTC timestamp
  const angolaDate = new Date(angolaMidnight.getTime() + ANGOLA_OFFSET_MS);
  const utcStartOfMonth = new Date(Date.UTC(
    angolaDate.getUTCFullYear(), angolaDate.getUTCMonth(), 1, 0, 0, 0
  ) - ANGOLA_OFFSET_MS);
  const matchStage = { $match: { user_hash: ctx.userHash, date: { $gte: utcStartOfMonth } } };

  const [totalsAgg, categoryAgg] = await Promise.all([
    ctx.transactions.aggregate([
      matchStage,
      { $group: {
        _id: null,
        income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
        expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } }
      }}
    ]).toArray(),
    ctx.transactions.aggregate([
      matchStage,
      { $group: {
        _id: { category: { $toLower: '$description' }, type: '$type' },
        total: { $sum: '$amount' }
      }},
      { $group: {
        _id: '$_id.category',
        income: { $sum: { $cond: [{ $eq: ['$_id.type', 'income'] }, '$total', 0] } },
        expense: { $sum: { $cond: [{ $eq: ['$_id.type', 'expense'] }, '$total', 0] } }
      }},
      { $sort: { _id: 1 } }
    ]).toArray()
  ]);

  const income = Number(totalsAgg[0]?.income) || 0;
  const expenses = Number(totalsAgg[0]?.expense) || 0;

  if (!totalsAgg.length || (income === 0 && expenses === 0)) {
    await ctx.reply("Sem transações neste mês.");
    return;
  }

  const balance = Number.isFinite(income) && Number.isFinite(expenses) ? income - expenses : 0;
  const monthName = angolaDate.toLocaleDateString('pt-AO', { month: 'long', year: 'numeric' });

  let message = `\u{1F4CA} ${monthName.charAt(0).toUpperCase() + monthName.slice(1)}

\u{1F4B0} Entradas: ${formatKz(income)} Kz
\u{1F4B8} Saídas: ${formatKz(expenses)} Kz
\u{1F4C8} Saldo: ${formatKz(balance)} Kz

--- Por categoria:`;

  for (const cat of categoryAgg) {
    const catIncome = Number(cat.income) || 0;
    const catExpense = Number(cat.expense) || 0;
    const catBalance = Number.isFinite(catIncome) && Number.isFinite(catExpense)
      ? catIncome - catExpense : 0;
    const signal = catBalance >= 0 ? '+' : '';
    const displayName = cat._id.charAt(0).toUpperCase() + cat._id.slice(1);
    message += `\n${displayName}: ${signal}${formatKz(catBalance)} Kz`;
  }

  if (message.length > MAX_WHATSAPP_CHARS) message = message.substring(0, MAX_WHATSAPP_CHARS);
  await ctx.replyWithRetry(message);
}

// --- Session State Handlers ---

export async function handleAwaitingConfirmation(ctx) {
  const text = ctx.text;

  if (isAffirmative(text)) {
    const amount = Number(ctx.session.pending.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      await ctx.reply("Valor inválido. Tenta novamente.");
      ctx.markSessionDirty();
      ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
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
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
  } else if (isNegative(text)) {
    await ctx.reply("Cancelado.");
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}

export async function handleAwaitingDebtConfirmation(ctx) {
  const text = ctx.text;

  if (isAffirmative(text)) {
    const amount = Number(ctx.session.pendingDebt.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      await ctx.reply("Valor inválido. Tenta novamente.");
      ctx.markSessionDirty();
      ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
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
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
  } else if (isNegative(text)) {
    await ctx.reply("Cancelado.");
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}

export async function handleAwaitingPagoConfirm(ctx) {
  const text = ctx.text;

  if (isAffirmative(text)) {
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
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
  } else if (isNegative(text)) {
    await ctx.reply("Operação cancelada.");
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
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
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
    return;
  }

  // Update the name based on debt type
  const name = text.trim();

  // Validate name: max 30 chars, letters/accented chars/spaces only, no commands
  if (name.length === 0 || name.length > 30 || !/^[a-zA-Z\u00C0-\u00FF\s]+$/.test(name)) {
    await ctx.reply("Nome inválido. Usa só letras e espaços (máximo 30 caracteres).");
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
    return;
  }

  // Reject reserved confirmation keywords as debt names (e.g., "sim", "nao")
  if (!isValidDebtName(name)) {
    await ctx.reply("Nome inválido. Usa só letras e espaços (máximo 30 caracteres).");
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
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
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
    return;
  }

  const amount = Number(pendingDebt.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    await ctx.reply("Valor inválido. Tenta novamente.");
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
    return;
  }

  // Go to confirmation instead of inserting directly (consistent with other flows)
  ctx.markSessionDirty();
  ctx.sessions[ctx.sessionKey] = {
    state: SessionState.AWAITING_DEBT_CONFIRMATION,
    pendingDebt: pendingDebt
  };
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
              _id: { $gte: `${normalizedPhone}:`, $lt: `${normalizedPhone}:\uffff` }
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
          _id: { $gte: `${normalizedPhone}:`, $lt: `${normalizedPhone}:\uffff` }
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

      await ctx.replyWithRetry("\u2705 Todos os teus dados foram apagados permanentemente.");
      delete ctx.sessions[ctx.sessionKey];
    } catch (error) {
      console.error('[/APAGAR] Error during deletion:', error.message);
      await ctx.reply("Erro ao apagar dados. Tenta novamente mais tarde.");
      ctx.markSessionDirty();
      ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
      await ctx.saveSessionIfDirty();
    }
  } else if (isNegative(text)) {
    await ctx.reply("Operação cancelada. Os teus dados permanecem armazenados.");
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}

export async function handleAwaitingDesfazerConfirm(ctx) {
  const text = ctx.text;

  if (isAffirmative(text)) {
    const pendingDesfazer = ctx.session.pendingDesfazer;
    try {
      if (pendingDesfazer.type === 'transaction') {
        await ctx.transactions.deleteOne({ _id: pendingDesfazer.id, user_hash: ctx.userHash });
        await ctx.logEvent('transaction_undone', { type: pendingDesfazer.type });
      } else if (pendingDesfazer.type === 'debt') {
        await ctx.debts.deleteOne({ _id: pendingDesfazer.id, user_hash: ctx.userHash });
        await ctx.logEvent('debt_undone', { type: pendingDesfazer.type });
      }
      await ctx.replyWithRetry("\u2705 Desfeito! Último registo apagado.");
    } catch (err) {
      console.error('[/DESFAZER] Error deleting:', err.message);
      await ctx.reply("Erro ao desfazer. Tenta novamente mais tarde.");
    }
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
  } else if (isNegative(text)) {
    await ctx.reply("Operação cancelada.");
    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = { state: SessionState.IDLE };
    await ctx.saveSessionIfDirty();
  } else {
    await ctx.reply("Não entendi. Responde Sim ou Não.");
  }
}

// --- Fall-through Parsers ---

export async function handleDebtParse(ctx) {
  // Returns true if a debt was parsed/handled, false if debt parsing failed or was ambiguous
  try {
    const parsedDebt = await ctx.parseDebt(ctx.text);

    if (
      parsedDebt &&
      !parsedDebt.error &&
      ["recebido", "devido"].includes(parsedDebt.type) &&
      Number.isFinite(parsedDebt.amount) &&
      parsedDebt.amount > 0 &&
      parsedDebt.amount <= MAX_AMOUNT &&
      typeof parsedDebt.creditor === "string" &&
      parsedDebt.creditor.trim().length > 0 &&
      typeof parsedDebt.debtor === "string" &&
      parsedDebt.debtor.trim().length > 0
    ) {
      // Validate counterparty names against injection/garbage from OpenAI or regex
      if (parsedDebt.type === "recebido" && !isValidDebtName(parsedDebt.debtor)) {
        parsedDebt.debtor = "user"; // Trigger AWAITING_DEBTOR_NAME for valid name
      }
      if (parsedDebt.type === "devido" && !isValidDebtName(parsedDebt.creditor)) {
        parsedDebt.creditor = "user"; // Trigger AWAITING_DEBTOR_NAME for valid name
      }
      // Check if we need user input to fill in the counterparty name
      // Only enter AWAITING_DEBTOR_NAME when the COUNTERPARTY is "user" (unknown),
      // not when the self-party is "user" (which is always true for regex parses)
      if (
        (parsedDebt.type === "recebido" && parsedDebt.debtor === "user") ||
        (parsedDebt.type === "devido" && parsedDebt.creditor === "user")
      ) {
        ctx.markSessionDirty();
        ctx.sessions[ctx.sessionKey] = {
          state: SessionState.AWAITING_DEBTOR_NAME,
          pendingDebt: {
            type: parsedDebt.type,
            creditor: parsedDebt.creditor,
            debtor: parsedDebt.debtor,
            amount: parsedDebt.amount,
            description: parsedDebt.description
          }
        };
        await ctx.saveSessionIfDirty();
        if (parsedDebt.type === "recebido") {
          await ctx.reply("Quem te deve? Escreve o nome.");
        } else {
          await ctx.reply("Tu deves a quem? Escreve o nome.");
        }
        return true;
      }

      // Full info available, ask for confirmation
      ctx.markSessionDirty();
      ctx.sessions[ctx.sessionKey] = {
        state: SessionState.AWAITING_DEBT_CONFIRMATION,
        pendingDebt: {
          type: parsedDebt.type,
          creditor: parsedDebt.creditor,
          debtor: parsedDebt.debtor,
          amount: parsedDebt.amount,
          description: parsedDebt.description
        }
      };
      await ctx.saveSessionIfDirty();

      const whoOwes = parsedDebt.type === "recebido" ? parsedDebt.debtor : parsedDebt.creditor;
      const debtText = parsedDebt.type === "recebido"
        ? `${whoOwes} te deve ${formatKz(parsedDebt.amount)}`
        : `tu deves ${formatKz(parsedDebt.amount)} a ${whoOwes}`;
      await ctx.reply(
        `Registar que ${debtText} Kz?\nResponde: Sim ou Não`
      );
      return true;
    }
  } catch (err) {
    console.error("Debt parsing error:", err);
    // Fall through to transaction parsing
  }

  return false;
}

export async function handleTransactionParse(ctx) {
  // Always returns true — sends "didn't understand" if parsing fails
  try {
    const parsed = await ctx.parseTransaction(ctx.text);

    if (
      !parsed ||
      parsed.error ||
      !["income", "expense"].includes(parsed.type) ||
      !Number.isFinite(parsed.amount) ||
      typeof parsed.description !== "string" ||
      parsed.description.trim().length === 0
    ) {
      await ctx.reply("Não percebi. Reescreve a frase.");
      return true;
    }

    parsed.amount = Number(parsed.amount);
    parsed.description = parsed.description.trim();

    // Validate amount before presenting confirmation prompt
    if (parsed.amount <= 0 || parsed.amount > MAX_AMOUNT) {
      await ctx.reply("Valor inválido. Tenta novamente.");
      return true;
    }

    ctx.markSessionDirty();
    ctx.sessions[ctx.sessionKey] = {
      state: SessionState.AWAITING_CONFIRMATION,
      pending: parsed
    };
    await ctx.saveSessionIfDirty();

    await ctx.reply(
      `Registar ${parsed.type === "income" ? "entrada" : "saída"} de ${formatKz(parsed.amount)} Kz (${parsed.description})?\nResponde: Sim ou Não`
    );

    return true;
  } catch (err) {
    console.error(err);
    await ctx.reply("Erro ao processar. Tenta novamente.");
    return true;
  }
}