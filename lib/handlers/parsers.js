import { SessionState, isValidDebtName, formatKz, MAX_AMOUNT } from '../security.js';

// --- Fall-through Parsers ---

export async function handleDebtParse(ctx) {
  // Returns true if a debt was parsed/handled, false if debt parsing failed or was ambiguous
  try {
    const parsedDebt = await ctx.parseDebt(ctx.text);

    // Track OpenAI source
    if (parsedDebt && !parsedDebt.error) {
      if (parsedDebt.source === 'cache') {
        await ctx.logEvent('openai_cache_hit', { parse_type: 'debt' });
      } else if (parsedDebt.source === 'openai') {
        await ctx.logEvent('openai_call', { parse_type: 'debt' });
      }
    }

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
        ctx.sessions.set(ctx.sessionKey, {
          state: SessionState.AWAITING_DEBTOR_NAME,
          pendingDebt: {
            type: parsedDebt.type,
            creditor: parsedDebt.creditor,
            debtor: parsedDebt.debtor,
            amount: parsedDebt.amount,
            description: parsedDebt.description
          }
        });
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
      ctx.sessions.set(ctx.sessionKey, {
        state: SessionState.AWAITING_DEBT_CONFIRMATION,
        pendingDebt: {
          type: parsedDebt.type,
          creditor: parsedDebt.creditor,
          debtor: parsedDebt.debtor,
          amount: parsedDebt.amount,
          description: parsedDebt.description
        }
      });
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

    // Track OpenAI source
    if (parsed && !parsed.error) {
      if (parsed.source === 'cache') {
        await ctx.logEvent('openai_cache_hit', { parse_type: 'transaction' });
      } else if (parsed.source === 'openai') {
        await ctx.logEvent('openai_call', { parse_type: 'transaction' });
      }
    }

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
    ctx.sessions.set(ctx.sessionKey, {
      state: SessionState.AWAITING_CONFIRMATION,
      pending: parsed
    });
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
