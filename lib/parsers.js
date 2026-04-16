// --- Regex-based transaction parser constants ---
const INCOME_VERBS = ['vendi', 'recebi', 'ganhei', 'paiei', 'biolo', 'fezada'];
const EXPENSE_VERBS = ['comprei', 'gastei', 'paguei', 'gasto', 'pagamento', 'transferi', 'enviei'];

// --- Regex-based debt parser constants ---
const DEBT_VERBS_RECEBIDO = ['me deve', 'deve-me'];
const DEBT_VERBS_DEVIDO = ['eu devo', 'devo', 'emprestei a'];

// --- Text normalization (used by parsers) ---
function normalize(text) {
  return text.toLowerCase().trim();
}

function parseTransactionRegex(text) {
  const normalized = normalize(text);

  // Detect type by verbs
  let type = null;

  for (const verb of INCOME_VERBS) {
    if (normalized.includes(verb)) {
      type = 'income';
      break;
    }
  }

  // Special case: transfers to own account = income (money arriving in user's account)
  if ((normalized.includes('enviei') || normalized.includes('transferi')) && normalized.includes('minha conta')) {
    type = 'income';
  }

  if (!type) {
    for (const verb of EXPENSE_VERBS) {
      if (normalized.includes(verb)) {
        type = 'expense';
        break;
      }
    }
  }

  if (!type) return { error: 'ambiguous' };

  // Extract amount — prioritize currency-annotated amounts (e.g., "5000 kz") over bare numbers
  // NOTE: [\s]\d+ in the regex allows space-separated thousands ("200 000" → 200000) but may
  // over-match when a number is followed by an unrelated word starting with digits. The currency
  // suffix (kz/paus) anchor prevents most false positives for the first pattern.
  const currencyMatch = normalized.match(/(\d+(?:[\s]\d+)*)\s*(?:kz|paus)/i);
  const amountMatch = currencyMatch || normalized.match(/(\d+(?:[\s]\d+)*)/i);
  let amount = null;
  if (amountMatch) {
    amount = parseFloat(amountMatch[1].replace(/[\s]/g, ''));
  }

  if (!amount || isNaN(amount) || amount <= 0 || amount > 1_000_000_000) {
    return { error: 'ambiguous' };
  }

  // Extract description - try multiple patterns in order
  let description = '';

  // Pattern 1: "para X" (for transfers: "transferi 200000 para Hugo")
  const paraMatch = normalized.match(/para\s+([\w\u00C0-\u00FF]+(?:\s+[\w\u00C0-\u00FF]+)*)/iu);
  if (paraMatch) {
    description = normalized.includes('minha conta') ? 'transferência para conta' : `transferência para ${paraMatch[1]}`;
  } else {
    // Pattern 2: "de/do/da X" (e.g., "vendi 1000 de pao de trigo" → "pao de trigo")
    const descMatch = normalized.match(/\b(?:de|do|da|dos|das)\s+(.+)$/);
    if (descMatch) {
      description = descMatch[1].trim();
    } else {
      // Pattern 3: "em X" (e.g., "gastei 1000 em compras", "recebi 500 em dinheiro")
      const emMatch = normalized.match(/em\s+(.+)$/);
      if (emMatch) {
        description = emMatch[1].trim();
      } else {
        // Pattern 4: "com X" (e.g., "gastei 1000 com farinha")
        const comMatch = normalized.match(/com\s+([a-zA-Z\u00C0-\u00FF][\w\u00C0-\u00FF\s]*)(?:\s|$)/);
        if (comMatch) {
          description = comMatch[1].trim();
        } else {
          // Pattern 5: direct noun after amount (e.g., "gastei 3000 farinha")
          const directMatch = normalized.match(/\d+\s*(?:kz|paus)?\s+([a-zA-Z\u00C0-\u00FF][\w\u00C0-\u00FF\s]*)$/i);
          if (directMatch) {
            description = directMatch[1].trim();
          }
        }
      }
    }
  }

  return { type, amount, description };
}

function parseDebtRegex(text) {
  const normalized = normalize(text);

  // Helper to parse amounts with space-separated thousands (e.g., "200 000" → 200000)
  const parseAmount = (str) => parseFloat(str.replace(/[\s]/g, ''));

  // Pattern 1: "O João me deve 2000kz" or "João me deve 2000kz" - Someone owes user
  const pattern1 = /(?:o\s+)?([\w\u00C0-\u00FF]+)\s+me\s+deve\s+(\d+(?:[\s]\d+)*)\s*(kz)?/iu;
  const match1 = normalized.match(pattern1);
  if (match1) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match1[1],
      amount: parseAmount(match1[2]),
      description: `O ${match1[1]} me deve`
    };
  }

  // Pattern 2: "Me deve 2000 ao João" - Someone owes user (name after 'ao' or 'a')
  const pattern2 = /me\s+deve\s+(\d+(?:[\s]\d+)*)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match2 = normalized.match(pattern2);
  if (match2) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match2[3],
      amount: parseAmount(match2[1]),
      description: `Me deve ${match2[1]}`
    };
  }

  // Pattern 3: "Eu devo 1500 a Maria" - User owes someone (name after 'ao' or 'a')
  const pattern3 = /eu\s+devo\s+(\d+(?:[\s]\d+)*)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match3 = normalized.match(pattern3);
  if (match3) {
    return {
      type: "devido",
      creditor: match3[3],
      debtor: "user",
      amount: parseAmount(match3[1]),
      description: `Eu devo ${match3[1]}`
    };
  }

  // Pattern 4: "Devo 1500 a Maria" - User owes someone (name after 'ao' or 'a')
  const pattern4 = /devo\s+(\d+(?:[\s]\d+)*)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match4 = normalized.match(pattern4);
  if (match4) {
    return {
      type: "devido",
      creditor: match4[3],
      debtor: "user",
      amount: parseAmount(match4[1]),
      description: `Devo ${match4[1]}`
    };
  }

  // Pattern 5: "Emprestei 500 ao João" - User lent money (expects return)
  const pattern5 = /emprestei\s+(\d+(?:[\s]\d+)*)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match5 = normalized.match(pattern5);
  if (match5) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match5[3],
      amount: parseAmount(match5[1]),
      description: `Emprestei ${match5[1]}`
    };
  }

  return { error: 'ambiguous' };
}

export {
  normalize,
  parseTransactionRegex,
  parseDebtRegex,
  INCOME_VERBS,
  EXPENSE_VERBS,
  DEBT_VERBS_RECEBIDO,
  DEBT_VERBS_DEVIDO
};