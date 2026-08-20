import logger from '../logger.js';
import { SessionState, formatKz, getAngolaMidnightUTC, ANGOLA_OFFSET_MS } from '../security.js';
import { getCacheStats, getOpenAIStats } from '../cache.js';
import { formatDelta } from '../metrics.js';
import { getRandomTip, tutorialVideoLine } from '../tips.js';
import { createReferral, getAllReferralStats, normalizeReferralPhone, extractPhoneFromText, referralSuccessMessage, isValidReferralName } from '../referrals.js';

// --- Command names (single source of truth for session reset logic) ---
export const COMMANDS = new Set([
  'hoje', '/hoje', '/quemedeve', '/quemdevo', '/kilapi', '/stats', '/retencao', '/metricas', '/anunciar',
  'ajuda', '/ajuda', 'comandos', '/comandos',
  'privacidade', '/privacidade', 'termos', '/termos',
  'meusdados', '/meusdados', 'apagar', '/apagar',
  'resumo', '/resumo', 'mes', '/mes',
  'desfazer', '/desfazer', '/exportar',
  'feedback', '/feedback',
  'dica', '/dica',
  'indicar', '/indicar', 'referidos', '/referidos'
]);

export const MAX_WHATSAPP_CHARS = 1500;

// Per-admin broadcast cooldown (in-memory, resets on restart)
const broadcastCooldowns = new Map();
const BROADCAST_COOLDOWN_MS = 60 * 1000;

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
  ctx.sessions.set(ctx.sessionKey, {
    state: SessionState.AWAITING_PAGO_CONFIRM,
    pendingPago: { debtId: doc._id, name, type: doc.type, debtor: doc.debtor, creditor: doc.creditor, amount: doc.amount }
  });
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

  let today;
  try {
    today = await ctx.computeDailyMetrics();
  } catch (err) {
    logger.error(err, '[Stats] computeDailyMetrics error');
    await ctx.reply("Erro ao calcular metricas. Tenta novamente.");
    return;
  }
  const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let yesterday = null;
  try {
    yesterday = await ctx.getOrCreateSnapshot(yesterdayDate);
  } catch (err) {
    logger.error(err, '[Stats] Failed to load yesterday snapshot');
  }

  const cacheStats = getCacheStats();
  const openaiStats = getOpenAIStats();
  const uptime = process.uptime();
  const uptimeDays = Math.floor(uptime / 86400);
  const uptimeHours = Math.floor((uptime % 86400) / 3600);
  const uptimeMins = Math.floor((uptime % 3600) / 60);

  const d = (curr, prev) => {
    if (!prev && prev !== 0) return '';
    return ' ' + formatDelta(curr, prev);
  };

  const topCommands = Object.entries(today.commandsUsed || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cmd, cnt]) => `${cmd} ${cnt}`)
    .join(', ');

  const openaiTotal = openaiStats.calls + openaiStats.cacheHits;
  const openaiPct = openaiTotal > 0 ? Math.round((openaiStats.cacheHits / openaiTotal) * 100) : 0;

  const message = `\u{1F4CA} Stats ${today.date}
Novos: ${today.newUsers}${d(today.newUsers, yesterday?.newUsers)}
Ativos: ${today.activeUsers}${d(today.activeUsers, yesterday?.activeUsers)}
Retornando: ${today.returningUsers}
Msgs: ${today.totalMessages}${d(today.totalMessages, yesterday?.totalMessages)}
Transacoes: ${today.confirmedTransactions}${d(today.confirmedTransactions, yesterday?.confirmedTransactions)}
Dividas: ${today.debtsCreated}${d(today.debtsCreated, yesterday?.debtsCreated)}

Kz Entradas: ${formatKz(today.totalIncome)}
Kz Saidas: ${formatKz(today.totalExpense)}

Comandos: ${topCommands || 'nenhum'}
OpenAI: ${openaiStats.calls} calls | ${openaiPct}% cache
Cache: ${cacheStats.hitRate} | ${cacheStats.size} entries

Sistema: ${uptimeDays}d ${uptimeHours}h ${uptimeMins}m | MongoDB ${ctx.mongoConnected ? '✅' : '❌'}

Ver mais: /metricas | /retencao`;

  await ctx.reply(message);
}

export async function handleMetricas(ctx) {
  if (ctx.adminNumbers.length === 0) {
    await ctx.reply("Comando desativado.");
    return;
  }
  if (!ctx.adminNumbers.includes(ctx.from)) {
    await ctx.reply("Comando reservado para administradores.");
    return;
  }
  await ctx.logEvent('command_used', { command: 'metricas' });

  let snapshots;
  try {
    snapshots = await ctx.getRecentSnapshots(7);
  } catch (err) {
    logger.error(err, '[Metricas] Failed to load snapshots');
    await ctx.reply("Erro ao carregar metricas. Tenta novamente.");
    return;
  }

  if (snapshots.length === 0) {
    await ctx.reply("Sem dados ainda.");
    return;
  }

  // Build 7-day trend table

  // Calculate column widths
  const dates = snapshots.map(s => s.date.slice(5)); // "MM/DD" format
  const header = '      ' + dates.map(d => d.padStart(6)).join('');

  const newUsers = snapshots.map(s => String(s.newUsers));
  const activeUsers = snapshots.map(s => String(s.activeUsers));
  const returning = snapshots.map(s => String(s.returningUsers ?? 0));
  const msgs = snapshots.map(s => String(s.totalMessages));
  const trans = snapshots.map(s => String(s.confirmedTransactions));
  const debts = snapshots.map(s => String(s.debtsCreated));

  const padRow = (label, vals) => {
    return label.padEnd(7) + vals.map(v => v.padStart(6)).join('');
  };

  let message = `\u{1F4C8} Metricas - 7 dias\n\n`;
  message += header + '\n';
  message += padRow('Novos', newUsers) + '\n';
  message += padRow('Ativos', activeUsers) + '\n';
  message += padRow('Retorn.', returning) + '\n';
  message += padRow('Msgs', msgs) + '\n';
  message += padRow('Trans.', trans) + '\n';
  message += padRow('Dividas', debts) + '\n';

  // Weekly financial totals
  const totalIncome = snapshots.reduce((sum, s) => sum + (s.totalIncome || 0), 0);
  const totalExpense = snapshots.reduce((sum, s) => sum + (s.totalExpense || 0), 0);
  message += `\nSemana: +${formatKz(totalIncome)} Kz | -${formatKz(totalExpense)} Kz`;

  // OpenAI weekly stats
  const totalCalls = snapshots.reduce((sum, s) => sum + (s.openaiCalls || 0), 0);
  const totalCacheHits = snapshots.reduce((sum, s) => sum + (s.openaiCacheHits || 0), 0);
  const totalOpenAI = totalCalls + totalCacheHits;
  const cachePct = totalOpenAI > 0 ? Math.round((totalCacheHits / totalOpenAI) * 100) : 0;
  message += `\nOpenAI: ${totalCalls} calls | ${cachePct}% cache`;

  const safeMessage = message.length > MAX_WHATSAPP_CHARS
    ? message.substring(0, MAX_WHATSAPP_CHARS - 20) + '\n...(continua)'
    : message;
  await ctx.reply(safeMessage);
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

  let data;
  try {
    data = await ctx.getRetentionData();
  } catch (err) {
    logger.error(err, '[Retencao] getRetentionData error');
    await ctx.reply("Erro ao carregar retencao. Tenta novamente.");
    return;
  }
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
  // Evict stale cooldown entries (older than cooldown period)
  for (const [phone, time] of broadcastCooldowns) {
    if (Date.now() - time > BROADCAST_COOLDOWN_MS) broadcastCooldowns.delete(phone);
  }

  if (ctx.adminNumbers.length === 0) {
    await ctx.reply("Comando desativado.");
    return;
  }
  if (!ctx.adminNumbers.includes(ctx.from)) {
    await ctx.reply("Comando reservado para administradores.");
    return;
  }

  // Enforce cooldown between broadcasts
  const lastBroadcast = broadcastCooldowns.get(ctx.from);
  if (lastBroadcast && Date.now() - lastBroadcast < BROADCAST_COOLDOWN_MS) {
    const secondsLeft = Math.ceil((BROADCAST_COOLDOWN_MS - (Date.now() - lastBroadcast)) / 1000);
    await ctx.reply(`Aguarda ${secondsLeft}s antes de enviar outro anúncio.`);
    return;
  }

  // Preserve original casing (normalized `ctx.text` would lowercase the announcement).
  const announcement = (ctx.rawText || ctx.text).replace(/^\/?\s*anunciar\s*/i, '').trim();
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

  // Set cooldown on successful broadcast start
  broadcastCooldowns.set(ctx.from, Date.now());

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
    bgDelivery().catch(err => logger.error(err, '[ANUNCIAR] Background delivery error'));
  }
}

export async function handleAjuda(ctx) {
  await ctx.logEvent('command_used', { command: 'ajuda' });
  const tutorial = tutorialVideoLine();
  const helpMessage = `\u{1F4DA} Comandos do Contador
${tutorial ? `\n${tutorial}\n` : ''}
\u{1F4CA} SALDO:
• hoje - Saldo do dia
• resumo - Últimos 7 dias
• mes - Este mês

\u{1F4B0} DÍVIDAS:
• /quemedeve - Quem te deve
• /quemdevo - A quem deves
• /kilapi - Todas as dívidas
• /pago <nome> - Marcar como paga

\u{1F4DD} REGISTRAR:
• "vendi 1000 de pão" ou "biolo 5000"
• "comprei 500 kz de saldo" ou "gastei 200 paus"
• "João me deve 2000" ou "fezada de 3000"
• "eu devo 1000 a Maria"

← DESFAZER:
• /desfazer - Apagar último registo

\u{1F512} PRIVACIDADE:
• /meusdados - Ver teus dados
• /exportar - Exportar teus dados
• /apagar - Apagar tudo
• /privacidade - Política de privacidade
• /termos - Termos de uso

\u{1F4AC} FEEDBACK:
• /feedback <texto> - Enviar sugestão ou reportar problema

\u{1F393} DICAS:
• /dica - Dica financeira do dia

\u{1F4E2} INDICAR:
• /indicar <nome> <telefone> - Indica um vendedor e ganha saldo de dados

\u{1F4A1} Podes responder Sim, Ya, S ou Não, N para confirmar/cancelar.`;
  await ctx.reply(helpMessage);
}

export async function handlePrivacidade(ctx) {
  await ctx.logEvent('command_used', { command: 'privacidade' });
  // Data-location claim is operator-configurable via DATA_STORAGE_LOCATION so the
  // privacy statement never asserts a region the deployment doesn't actually use.
  // Default avoids naming a specific region; set the env var to the accurate location.
  const dataStorageLine = process.env.DATA_STORAGE_LOCATION
    ? `• Dados armazenados: ${process.env.DATA_STORAGE_LOCATION}`
    : '• Dados armazenados em conformidade com a Lei 22/11 (Angola)';
  const privacyMessage = `\u{1F512} PRIVACIDADE

O Contador guarda:
• Teu número (com hash SHA-256)
• Transações (vendas, gastos)
• Dívidas (quem deve, quem deve)
• Indicações (nome e número de quem indicaste, para o programa de referidos)

Base legal (Lei 22/11):
• Consentimento explícito
• Interesse legítimo (programa de referidos)
${dataStorageLine}

Teus direitos:
• /meusdados - Ver teus dados
• /apagar - Apagar tudo

Política completa: https://riclex.github.io/contador/PRIVACY.html`;
  await ctx.reply(privacyMessage);
}

export async function handleTermos(ctx) {
  await ctx.logEvent('command_used', { command: 'termos' });
  const termosMessage = `\u{1F4C4} TERMOS DE USO

O Contador é um assistente financeiro via WhatsApp.

Importante:
• Serviço "como está" (sem garantias)
• Tu és responsável pelos dados
• Não é instituição financeira
• Limite: 50 mensagens/dia

Preço:
• Gratuito (fase MVP)

Termos completos: https://riclex.github.io/contador/TERMS.html`;
  await ctx.reply(termosMessage);
}

// /dica — on-demand financial tip from a static, Angola-localized library.
// Education (general guidance), not advice. Zero OpenAI cost. On-demand only:
// the bot never pushes tips, and this handler is outside the confirm→record flow.
export async function handleDica(ctx) {
  await ctx.logEvent('command_used', { command: 'dica' });
  const tip = getRandomTip();
  await ctx.reply(`\u{1F4A1} Dica: ${tip.text}`);
}

// /indicar — refer a vendor by name + phone. The referrer earns data credit once
// the referred person actually uses the product (logs >= REFERRAL_EARN_TRANSACTIONS).
// Two-step flow: /indicar <nome> <telefone> in one message, or /indicar then the
// bot prompts for name and phone separately.
export async function handleIndicar(ctx) {
  await ctx.logEvent('command_used', { command: 'indicar' });

  // Use the sanitized-but-not-lowercased text so the referred person's name keeps its
  // original casing (the normalized `ctx.text` would store "maria" instead of "Maria").
  const rest = (ctx.rawText || ctx.text).replace(/^\/?\s*indicar\s*/i, '').trim();

  // No args → start the two-step flow (prompt for name).
  if (!rest) {
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, { state: SessionState.AWAITING_REFERRAL_NAME });
    await ctx.saveSessionIfDirty();
    await ctx.reply("Indica um vendedor e ganha saldo de dados quando ele começar a usar.\n\nEscreve o nome da pessoa:");
    return;
  }

  // Try to parse name + phone from the single message.
  const phoneToken = extractPhoneFromText(rest);
  const phone = phoneToken ? normalizeReferralPhone(phoneToken) : null;
  const name = phoneToken ? rest.replace(phoneToken, '').trim() : rest;

  // Reject invalid names early (an empty name is handled by the two-step prompt below).
  if (name && !isValidReferralName(name)) {
    await ctx.reply("Nome inválido. Usa só letras e espaços (máximo 50 caracteres).");
    return;
  }

  if (!phone) {
    // Phone missing or invalid. If we also have no name (e.g. the user typed only an
    // invalid phone), start from the name step instead of carrying an empty name forward.
    if (!name) {
      ctx.markSessionDirty();
      ctx.sessions.set(ctx.sessionKey, { state: SessionState.AWAITING_REFERRAL_NAME });
      await ctx.saveSessionIfDirty();
      await ctx.reply("Escreve o nome da pessoa:");
      return;
    }
    // Otherwise capture the name we already have and prompt for the phone.
    ctx.markSessionDirty();
    ctx.sessions.set(ctx.sessionKey, {
      state: SessionState.AWAITING_REFERRAL_PHONE,
      pendingReferral: { name: name.substring(0, 50) }
    });
    await ctx.saveSessionIfDirty();
    await ctx.reply(`Nome: ${name}\n\nAgora escreve o número de WhatsApp da pessoa (com o código 244). Exemplo: 244912345678`);
    return;
  }

  await finalizeReferral(ctx, { name, phone });
}

// Shared final step: validate + store the referral, reply to the user.
async function finalizeReferral(ctx, { name, phone }) {
  if (!isValidReferralName(name)) {
    await ctx.reply("Falta o nome. Exemplo: /indicar Maria 244912345678");
    return;
  }
  const result = await createReferral(ctx.referrals, {
    referrerHash: ctx.userHash,
    referredPhone: phone,
    name
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
    return;
  }
  await ctx.logEvent('referral_created', { referred_hash: result.referredHash });
  await ctx.reply(referralSuccessMessage(name));
}

// /referidos — admin-only view of the referral funnel.
export async function handleReferidos(ctx) {
  if (ctx.adminNumbers.length === 0) {
    await ctx.reply("Comando desativado.");
    return;
  }
  if (!ctx.adminNumbers.includes(ctx.from)) {
    await ctx.reply("Comando reservado para administradores.");
    return;
  }
  await ctx.logEvent('command_used', { command: 'referidos' });

  const stats = await getAllReferralStats(ctx.referrals);
  let message = `\u{1F4E2} Referidos\n\nPendentes: ${stats.pending}\nAtivados: ${stats.activated}\nGanhos: ${stats.earned}\nPagos: ${stats.paid}\n\nÚltimos:`;
  if (stats.recent.length === 0) {
    message += '\n(ainda sem indicações)';
  } else {
    for (const r of stats.recent) {
      message += `\n• ${r.name || '?'} — ${r.status}`;
    }
  }
  const safeMessage = message.length > MAX_WHATSAPP_CHARS
    ? message.substring(0, MAX_WHATSAPP_CHARS)
    : message;
  await ctx.reply(safeMessage);
}

export async function handleMeusdados(ctx) {
  await ctx.logEvent('command_used', { command: 'meusdados' });

  // Get user data — counts only (individual records are not displayed, so no find().toArray())
  const totalTransactions = await ctx.transactions.countDocuments({ user_hash: ctx.userHash });
  const activeDebts = await ctx.debts.countDocuments({ user_hash: ctx.userHash, settled: { $ne: true } });
  const totalEvents = await ctx.events.countDocuments({ user_hash: ctx.userHash });

  // Aggregate totals from ALL transactions
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

\u{1F464} Usuário: ${(() => { const num = ctx.from.replace('whatsapp:', ''); return '•'.repeat(num.length - 4) + num.slice(-4); })()}

\u{1F4CA} RESUMO:
• Transações: ${totalTransactions}
• Receitas: ${formatKz(totalIncome)} Kz
• Despesas: ${formatKz(totalExpenses)} Kz
• Saldo: ${formatKz(totalIncome - totalExpenses)} Kz
• Dívidas ativas: ${activeDebts}

\u{1F512} EVENTOS (auditoria):
• Total: ${totalEvents}

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
  // Referral records where the user is the referrer (deleted) or the referred person (scrubbed).
  let userReferrals = 0;
  if (ctx.referrals) {
    userReferrals = await ctx.referrals.countDocuments({
      $or: [{ referrer_hash: ctx.userHash }, { referred_hash: ctx.userHash }]
    });
  }

  if (userTransactions === 0 && userDebts === 0 && userEvents === 0 && userReferrals === 0) {
    await ctx.reply("Não tens dados armazenados para apagar.");
    return;
  }

  // Ask for confirmation
  ctx.markSessionDirty();
  ctx.sessions.set(ctx.sessionKey, { state: SessionState.AWAITING_APAGAR_CONFIRM });
  await ctx.saveSessionIfDirty();

  const message = `⚠️ CONFIRMAÇÃO

Tens os seguintes dados armazenados:
• Transações: ${userTransactions}
• Dívidas: ${userDebts}
• Eventos: ${userEvents}
• Indicações: ${userReferrals}

Esta ação é PERMANENTE e não pode ser desfeita.

Responde "sim" para apagar TODOS os teus dados ou "não" para cancelar.`;
  await ctx.reply(message);
}

export async function handleDesfazer(ctx) {
  await ctx.logEvent('command_used', { command: 'desfazer' });

  // Find the most recent *action* across three kinds of writes:
  //   - transaction inserts            (by transaction `date`)
  //   - unsettled debt inserts         (by debt `date`)
  //   - debt settlements via /pago     (by `settled_date`)
  // The latest of the three is what /desfazer offers to undo. Settling a debt
  // updates `settled_date` (not `date`), so we query it separately — otherwise a
  // just-settled old debt would never surface as "the last thing you did".
  const [lastTransaction, lastDebt, lastSettledDebt] = await Promise.all([
    ctx.transactions.find({ user_hash: ctx.userHash }).sort({ date: -1 }).limit(1).toArray(),
    ctx.debts.find({ user_hash: ctx.userHash, settled: { $ne: true } }).sort({ date: -1 }).limit(1).toArray(),
    ctx.debts.find({ user_hash: ctx.userHash, settled: true, settled_date: { $ne: null } }).sort({ settled_date: -1 }).limit(1).toArray()
  ]);

  const txDate = lastTransaction.length > 0 ? lastTransaction[0].date : null;
  const debtDate = lastDebt.length > 0 ? lastDebt[0].date : null;
  const settleDate = lastSettledDebt.length > 0 ? lastSettledDebt[0].settled_date : null;

  if (!txDate && !debtDate && !settleDate) {
    await ctx.reply("Não tens registos para desfazer.");
    return;
  }

  const latest = Math.max(
    txDate ? txDate.getTime() : 0,
    debtDate ? debtDate.getTime() : 0,
    settleDate ? settleDate.getTime() : 0
  );

  let pendingDesfazer;
  if (settleDate && settleDate.getTime() === latest) {
    // Undo a /pago by REOPENING the debt — never delete a settled debt as "undo".
    const d = lastSettledDebt[0];
    const who = d.type === 'recebido' ? `${d.debtor} te deve` : `tu deves a ${d.creditor}`;
    pendingDesfazer = { type: 'debt_reopen', id: d._id, detail: `desmarcar pagamento: ${who} ${formatKz(d.amount)} Kz` };
  } else if (txDate && txDate.getTime() === latest) {
    const t = lastTransaction[0];
    pendingDesfazer = { type: 'transaction', id: t._id, detail: `${t.type === 'income' ? 'entrada' : 'saída'} de ${formatKz(t.amount)} Kz` };
  } else {
    const d = lastDebt[0];
    const who = d.type === 'recebido' ? `${d.debtor} te deve` : `tu deves a ${d.creditor}`;
    pendingDesfazer = { type: 'debt', id: d._id, detail: `dívida: ${who} ${formatKz(d.amount)} Kz` };
  }

  ctx.markSessionDirty();
  ctx.sessions.set(ctx.sessionKey, {
    state: SessionState.AWAITING_DESFAZER_CONFIRM,
    pendingDesfazer
  });
  await ctx.saveSessionIfDirty();
  await ctx.reply(`Desfazer o último registo?\n${pendingDesfazer.detail}\nResponde: Sim ou Não`);
}

export async function handleFeedback(ctx) {
  // Preserve original casing (normalized `ctx.text` would lowercase the feedback).
  const feedbackText = (ctx.rawText || ctx.text).replace(/^\/?\s*feedback\s*/i, '').trim();
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

// Build a JSON export that fits within `maxChars`, always emitting VALID JSON.
// If the full payload is too large, drops the oldest transactions first, then
// debts, until it fits — totals.transaction_count still reflects the REAL total,
// so a consumer can see the array is a partial slice. Returns null only if even
// the totals-only object won't fit (essentially unreachable), so the caller can
// send a fallback message instead of broken JSON. Never hard-truncates a string.
function buildExportJson(exportData, maxChars) {
  const stringify = (d) => JSON.stringify(d, null, 2);
  const full = stringify(exportData);
  if (full.length <= maxChars) return full;

  const trimmed = {
    ...exportData,
    transactions: [...exportData.transactions],
    debts: [...exportData.debts],
    _complete: false
  };
  let json = stringify(trimmed);
  while (json.length > maxChars && trimmed.transactions.length > 0) {
    trimmed.transactions.shift();
    json = stringify(trimmed);
  }
  while (json.length > maxChars && trimmed.debts.length > 0) {
    trimmed.debts.shift();
    json = stringify(trimmed);
  }
  return json.length <= maxChars ? json : null;
}

export async function handleExportar(ctx) {
  const isJson = /\bjson\b/i.test(ctx.text);
  await ctx.logEvent('command_used', { command: isJson ? 'exportar_json' : 'exportar' });

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

  // Show recent transactions (up to message limit)
  const recentTx = await ctx.transactions.find({ user_hash: ctx.userHash }).sort({ date: -1 }).limit(30).toArray();

  if (isJson) {
    const exportData = {
      exported_at: new Date().toISOString(),
      totals: {
        income: totalIncome,
        expenses: totalExpenses,
        balance: totalIncome - totalExpenses,
        transaction_count: totalTransactions
      },
      debts: debts.map(d => ({
        type: d.type,
        creditor: d.creditor,
        debtor: d.debtor,
        amount: d.amount,
        description: d.description,
        date: d.date,
        settled: d.settled
      })),
      transactions: recentTx.map(t => ({
        type: t.type,
        amount: t.amount,
        description: t.description,
        date: t.date
      }))
    };
    const json = buildExportJson(exportData, MAX_WHATSAPP_CHARS);
    if (json === null) {
      await ctx.replyWithRetry("Exportação demasiado grande para uma mensagem. Usa /exportar para um resumo, ou contacta-nos para a exportação completa.");
      return;
    }
    await ctx.replyWithRetry(json);
    return;
  }

  let message = `\u{1F4E4} EXPORTAÇÃO DE DADOS

\u{1F4CA} TOTAIS:
• Entradas: ${formatKz(totalIncome)} Kz (${incomeCount})
• Saídas: ${formatKz(totalExpenses)} Kz (${expenseCount})
• Saldo: ${formatKz(totalIncome - totalExpenses)} Kz
• Transações: ${totalTransactions}`;

  if (debts.length > 0) {
    message += `\n\n\u{1F4B3} DÍVIDAS ATIVAS:`;
    for (const d of debts) {
      const who = d.type === 'recebido' ? `${d.debtor} te deve` : `Tu deves a ${d.creditor}`;
      message += `\n• ${who}: ${formatKz(d.amount)} Kz`;
    }
  }

  if (recentTx.length > 0) {
    message += `\n\n\u{1F4CB} ÚLTIMAS ${recentTx.length} TRANSações:`;
    for (const t of recentTx) {
      const icon = t.type === 'income' ? '⬆' : '⬇';
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

// --- Command dispatch maps ---
// Exact-match commands (O(1) lookup, no regex overhead)
export const EXACT_COMMANDS = new Map([
  ['hoje', handleHoje],
  ['/hoje', handleHoje],
  ['/stats', handleStats],
  ['/retencao', handleRetencao],
  ['/metricas', handleMetricas],
  ['ajuda', handleAjuda],
  ['/ajuda', handleAjuda],
  ['comandos', handleAjuda],
  ['/comandos', handleAjuda],
  ['privacidade', handlePrivacidade],
  ['/privacidade', handlePrivacidade],
  ['termos', handleTermos],
  ['/termos', handleTermos],
  ['meusdados', handleMeusdados],
  ['/meusdados', handleMeusdados],
  ['apagar', handleApagar],
  ['/apagar', handleApagar],
  ['desfazer', handleDesfazer],
  ['/desfazer', handleDesfazer],
  ['resumo', handleResumo],
  ['/resumo', handleResumo],
  ['mes', handleMes],
  ['/mes', handleMes],
  ['/exportar', handleExportar],
  ['dica', handleDica],
  ['/dica', handleDica],
  ['indicar', handleIndicar],
  ['/indicar', handleIndicar],
  ['referidos', handleReferidos],
  ['/referidos', handleReferidos],
]);

// Regex-based commands (with capture groups for arguments)
export const REGEX_COMMANDS = [
  // /indicar <nome> <telefone> — the one-shot form advertised in /ajuda. EXACT_COMMANDS
  // only matches the bare `indicar`/`/indicar` (which starts the two-step flow), so this
  // pattern is what routes the documented one-message form. Without it, the input falls
  // through to the debt/transaction parser and the referral is never created.
  { pattern: /^\/?indicar\s+.+$/i, handler: (ctx) => handleIndicar(ctx) },
  { pattern: /^\/quemedeve(?:\s+(\d+))?$/i, handler: (ctx, m) => handleQuemedeve(ctx, parseInt(m[1] || '1', 10)) },
  { pattern: /^\/quemdevo(?:\s+(\d+))?$/i, handler: (ctx, m) => handleQuemdevo(ctx, parseInt(m[1] || '1', 10)) },
  { pattern: /^\/kilapi(?:\s+(\d+))?$/i, handler: (ctx, m) => handleKilapi(ctx, parseInt(m[1] || '1', 10)) },
  { pattern: /^\/pago\s+(.+)/i, handler: (ctx, m) => handlePago(ctx, m[1].trim()) },
  { pattern: /^\/anunciar/i, handler: (ctx) => handleAnunciar(ctx) },
  { pattern: /^\/feedback/i, handler: (ctx) => handleFeedback(ctx) },
];
