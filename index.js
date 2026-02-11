import express from "express";
import bodyParser from "body-parser";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import twilio from "twilio";

// --- Regex-based transaction parser constants
const INCOME_VERBS = ['vendi', 'recebi', 'ganhei', 'paiei', 'biolo', 'fezada'];
const EXPENSE_VERBS = ['comprei', 'gastei', 'paguei', 'gasto', 'pagamento', 'emprestei'];

function parseTransactionRegex(text) {
  const normalized = text.toLowerCase().trim();

  // Detect type by verbs
  let type = null;

  for (const verb of INCOME_VERBS) {
    if (normalized.includes(verb)) {
      type = 'income';
      break;
    }
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

  // Extract amount (number, optionally followed by Kz or paus)
  const amountMatch = normalized.match(/(\d+)\s*(kz|paus)?/);
  const amount = amountMatch ? parseInt(amountMatch[1]) : null;

  if (!amount) return { error: 'ambiguous' };

  // Extract description (text after de/do/da)
  const descMatch = normalized.match(/(?:de|do|da)\s+(.+?)(?:\b|$)/);
  const description = descMatch ? descMatch[1].trim() : '';

  return { type, amount, description };
}

// --- Regex-based debt parser constants
const DEBT_VERBS_RECEBIDO = ['me deve', 'me deve', 'deve-me'];
const DEBT_VERBS_DEVIDO = ['eu devo', 'devo', 'emprestei a'];

function parseDebtRegex(text) {
  const normalized = text.toLowerCase().trim();

  // Pattern 1: "O João me deve 2000kz" or "João me deve 2000kz" - Someone owes user
  const pattern1 = /(?:o\s+)?([\w\u00C0-\u00FF]+)\s+me\s+deve\s+(\d+)\s*(kz)?/iu;
  const match1 = normalized.match(pattern1);
  if (match1) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match1[1],
      amount: parseInt(match1[2]),
      description: `O ${match1[1]} me deve`
    };
  }

  // Pattern 2: "Me deve 2000 ao João" - Someone owes user (name after 'ao' or 'a')
  const pattern2 = /me\s+deve\s+(\d+)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match2 = normalized.match(pattern2);
  if (match2) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match2[3],
      amount: parseInt(match2[1]),
      description: `Me deve ${match2[1]}`
    };
  }

  // Pattern 3: "Eu devo 1500 ao Maria" - User owes someone (name after 'ao' or 'a')
  const pattern3 = /eu\s+devo\s+(\d+)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match3 = normalized.match(pattern3);
  if (match3) {
    return {
      type: "devido",
      creditor: match3[3],
      debtor: "user",
      amount: parseInt(match3[1]),
      description: `Eu devo ${match3[1]}`
    };
  }

  // Pattern 4: "Devo 1500 a Maria" - User owes someone (name after 'ao' or 'a')
  const pattern4 = /devo\s+(\d+)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match4 = normalized.match(pattern4);
  if (match4) {
    return {
      type: "devido",
      creditor: match4[3],
      debtor: "user",
      amount: parseInt(match4[1]),
      description: `Devo ${match4[1]}`
    };
  }

  // Pattern 5: "Emprestei 500 ao João" - User lent money (expects return)
  const pattern5 = /emprestei\s+(\d+)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match5 = normalized.match(pattern5);
  if (match5) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match5[3],
      amount: parseInt(match5[1]),
      description: `Emprestei ${match5[1]}`
    };
  }

  return { error: 'ambiguous' };
}

const MAX_PROCESSED_MESSAGES = 10000;
const processedMessages = new Set();
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- Environment Validation
const requiredEnvVars = ["MONGODB_URI", "OPENAI_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
const missing = requiredEnvVars.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// --- Clients
const mongo = new MongoClient(process.env.MONGODB_URI);
try {
  await mongo.connect();
  console.log("Connected to MongoDB");
} catch (err) {
  console.error("Failed to connect to MongoDB:", err.message);
  process.exit(1);
}
const db = mongo.db();
const transactions = db.collection("transactions");
const debts = db.collection("debts");

// Create indexes on debts collection
await debts.createIndex({ user_phone: 1, settled: 1 });
await debts.createIndex({ user_phone: 1, creditor: 1, debtor: 1 });
await debts.createIndex({ message_sid: 1 });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function parseDebtOpenAI(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a strict debt tracking message parser. \
          Your task is to extract a single debt transaction from a Portuguese sentence. \
          You MUST output a JSON object with exactly these keys:\
          type: 'recebido' or 'devido'\
          creditor: string (who is owed money)\
          debtor: string (who owes money)\
          amount: number (integer, no currency symbols)\
          description: short string from the sentence.\
          Rules (MANDATORY): \
          1. Type mapping: \
          - 'recebido' = someone owes the user (e.g., 'João me deve', 'O João deve')\
          - 'devido' = user owes someone (e.g., 'eu devo', 'devo')\
          2. Amount: \
          - Extract numeric amount, ignore currency (Kz, kz, KZ, paus)\
          3. Description: \
          - Use relevant words from the sentence\
          4. Ambiguity: \
          - ONLY output {'error':'ambiguous'} if no debt relationship can be determined. \
          5. Output: \
          - Output ONLY valid JSON. \
          - No explanations. \
          - No extra keys. \
          Examples: \
          Input: 'O João me deve 2000kz'\
          Output: {'type':'recebido','creditor':'user','debtor':'João','amount':2000,'description':'O João me deve'}\
          Input: 'Eu devo 1500 a Maria'\
          Output: {'type':'devido','creditor':'Maria','debtor':'user','amount':1500,'description':'Eu devo 1500'}\
          Input: 'Maria deve-me 3000'\
          Output: {'type':'recebido','creditor':'user','debtor':'Maria','amount':3000,'description':'Maria deve-me'}\
          Input: 'Emprestei 500 ao João'\
          Output: {'type':'recebido','creditor':'user','debtor':'João','amount':500,'description':'Emprestei 500'}\
          Input: 'Devo 200 a Ana'\
          Output: {'type':'devido','creditor':'Ana','debtor':'user','amount':200,'description':'Devo 200'}\
          "
      },
      {
        role: "user",
        content: `Extrai uma dívida desta frase:\n"${text}"`
      }
    ]
  });

  return JSON.parse(response.choices[0].message.content);
}

async function parseDebt(text) {
  // Try regex first (fast, free)
  const regexResult = parseDebtRegex(text);
  if (regexResult.error !== 'ambiguous') {
    return regexResult;
  }

  // Fallback to OpenAI for ambiguous cases
  return parseDebtOpenAI(text);
}

// --- In-memory sessions
// State types: IDLE, AWAITING_CONFIRMATION, AWAITING_DEBT_CONFIRMATION, AWAITING_DEBTOR_NAME
const sessions = {};

// --- Helpers
function normalize(text) {
  return text.toLowerCase().trim();
}

async function parseTransaction(text) {
  // Try regex first (fast, free)
  const regexResult = parseTransactionRegex(text);
  if (regexResult.error !== 'ambiguous') {
    return regexResult;
  }

  // Fallback to OpenAI for ambiguous cases
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a strict financial message parser. \
          Your task is to extract a single financial transaction from a Portuguese sentence. \
          You MUST output a JSON object with exactly these keys:\
          type: 'income' or 'expense'\
          amount: number (integer, no currency symbols)\
          description: short string taken from the sentence.\
          Rules (MANDATORY): \
          1. Verb mapping: \
          - Any sentence containing verbs like 'gastei', 'paguei', 'comprei', 'gasto', 'pagamento' → type = 'expense'.\
          - Any sentence containing verbs like 'recebi', 'vendi', 'ganhei', 'paiei', 'biolo', 'fezada'→ type = 'income' \
          2. Amount: \
          - If a numeric amount is present, extract it. \
          - Ignore currency case (Kz, kz, KZ, AKZ, akz, paus are the same)\
          3. Description: \
          - Use the words after 'de', 'do', 'da' when present.\
          - If description is generic (e.g. 'saldo'), it is STILL VALID.\
          4. Ambiguity: \
          - ONLY output {'error':'ambiguous'} if: \
          - No numeric amount exists \
          - OR no verb exists \
          - OR transaction type cannot be determined. \
          5. Output: \
          - Output ONLY valid JSON. \
          - No explanatations. \
          - No extra keys. \
          Examples: \
          Input: 'Gastei 1500 Kz de saldo'\
          Output: {'type':'expense','amount':1500,'description':'saldo'}\
          Input: 'Comprei 1000 kz de fuba'\
          Output: {'type':'expense','amount':1000,'description':'fuba'}\
          Input: 'Recebi 2000 Kz do João'\
          Output: {'type':'income','amount':2000,'description':'do João'}\
          Input: 'Comprei pão'\
          Output: {'error':'ambiguous'}\
          Input: 'Pus saldo'\
          Output: {'error':'ambiguous'}\
          Input: 'Emprestei 500 kz'\
          Output: {'type':'expense','amount':500,'description':'divida'}\
          Input: 'Fezade de 3000 kz'\
          Output: {'type':'income','amount':3000,'description':'fezada'}\
          Input: 'Biolo 2500 kz'\
          Output: {'type':'income','amount':2500,'description':'biolo'}\
          Input: 'Paiei 3000 paus num wi'\
          Output: {'type':'income','amount':3000,'description':'wi'}\
          "
      },
      {
        role: "user",
        content: `Extrai uma transação financeira desta frase:\n"${text}"`
      }
    ]
  });

  return JSON.parse(response.choices[0].message.content);
}

const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";

async function reply(to, body) {
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body
  });
}

// --- Routes
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const text = normalize(req.body.Body) || "";
  const messageSid = req.body.MessageSid;

  // Retry protection
  if (!messageSid) {
    return res.sendStatus(204);
  }

  if (processedMessages.has(messageSid)) {
    return res.sendStatus(204);
  }

  processedMessages.add(messageSid);

  if (processedMessages.size > MAX_PROCESSED_MESSAGES) {
    const iterator = processedMessages.values();
    const first = iterator.next().value;
    processedMessages.delete(first);
  }

  if (!sessions[from]) {
    sessions[from] = { state: "IDLE" };
  }

  const session = sessions[from];

  // Command: hoje
  if (text === "hoje") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const docs = await transactions.find({
      user_phone: from,
      date: { $gte: start }
    }).toArray();

    let total = 0;

    for (const t of docs) {
      const amount = Number(t.amount);

      if (!Number.isFinite(amount)) continue;

      if (t.type === "income") {
        total += amount;
      } else if (t.type === "expense") {
        total -= amount;
      }
    }

    await reply(from, `Total de hoje: ${total} Kz`);
    return res.sendStatus(204);
  }

  // Command: /quemedeve - Who owes user
  if (text === "/quemedeve") {
    const docs = await debts.find({
      user_phone: from,
      type: "recebido",
      settled: { $ne: true }
    }).toArray();

    if (docs.length === 0) {
      await reply(from, "Ninguém te deve dinheiro.");
      return res.sendStatus(204);
    }

    let message = "Quem te deve dinheiro:\n";
    for (const d of docs) {
      message += `- ${d.debtor}: ${d.amount} Kz\n`;
    }
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: /quemdevo - Who user owes
  if (text === "/quemdevo") {
    const docs = await debts.find({
      user_phone: from,
      type: "devido",
      settled: { $ne: true }
    }).toArray();

    if (docs.length === 0) {
      await reply(from, "Tu não deves dinheiro a ninguém.");
      return res.sendStatus(204);
    }

    let message = "Tu deves dinheiro a:\n";
    for (const d of docs) {
      message += `- ${d.creditor}: ${d.amount} Kz\n`;
    }
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: /kilapi - All debts
  if (text === "/kilapi") {
    const docs = await debts.find({
      user_phone: from,
      settled: { $ne: true }
    }).toArray();

    if (docs.length === 0) {
      await reply(from, "Não tens dívidas ativas.");
      return res.sendStatus(204);
    }

    let message = "Dívidas ativas:\n";
    for (const d of docs) {
      if (d.type === "recebido") {
        message += `- ${d.debtor} te deve: ${d.amount} Kz\n`;
      } else {
        message += `- Tu deves a ${d.creditor}: ${d.amount} Kz\n`;
      }
    }
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: /pago - Mark debt as paid
  const pagoMatch = text.match(/^\/pago\s+(.+)/i);
  if (pagoMatch) {
    const name = pagoMatch[1].trim();
    // Escape special regex characters to prevent ReDoS attacks
    const sanitizedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const doc = await debts.findOne({
      user_phone: from,
      settled: { $ne: true },
      $or: [
        { creditor: { $regex: new RegExp(sanitizedName, "i") } },
        { debtor: { $regex: new RegExp(sanitizedName, "i") } }
      ]
    });

    if (!doc) {
      await reply(from, "Não encontrei esta dívida. Use /dividas para ver as dívidas ativas.");
      return res.sendStatus(204);
    }

    await debts.updateOne(
      { _id: doc._id },
      { $set: { settled: true, settled_date: new Date() } }
    );

    if (doc.type === "recebido") {
      await reply(from, `Dívida de ${doc.debtor} (que te deve ${doc.amount} Kz) marcada como paga.`);
    } else {
      await reply(from, `Dívida a ${doc.creditor} (que tu deves ${doc.amount} Kz) marcada como paga.`);
    }
    return res.sendStatus(204);
  }

  // Awaiting confirmation (regular transaction)
  if (session.state === "AWAITING_CONFIRMATION") {
    if (text === "sim") {
      try {
        await transactions.insertOne({
          message_sid: messageSid,
          user_phone: from,
          type: session.pending.type,
          amount: Number(session.pending.amount),
          description: session.pending.description,
          date: new Date()
        });
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
      await reply(from, "Registado.");
    } else {
      await reply(from, "Cancelado.");
    }
    sessions[from] = { state: "IDLE" };
    return res.sendStatus(204);
  }

  // Awaiting debt confirmation
  if (session.state === "AWAITING_DEBT_CONFIRMATION") {
    if (text === "sim") {
      try {
        await debts.insertOne({
          message_sid: messageSid,
          user_phone: from,
          type: session.pendingDebt.type,
          creditor: session.pendingDebt.creditor,
          debtor: session.pendingDebt.debtor,
          amount: session.pendingDebt.amount,
          description: session.pendingDebt.description,
          date: new Date(),
          settled: false,
          settled_date: null
        });
        await reply(from, "Dívida registada.");
      } catch (e) {
        if (e.code !== 11000) throw e;
        await reply(from, "Dívida registada.");
      }
    } else {
      await reply(from, "Cancelado.");
    }
    sessions[from] = { state: "IDLE" };
    return res.sendStatus(204);
  }

  // Handle Awaiting Debtor Name state (for regex parses where name was 'user')
  if (session.state === "AWAITING_DEBTOR_NAME") {
    const pendingDebt = session.pendingDebt;

    if (text === "nao" || text === "não") {
      await reply(from, "Cancelado.");
      sessions[from] = { state: "IDLE" };
      return res.sendStatus(204);
    }

    // Update the name based on debt type
    if (pendingDebt.type === "recebido" && pendingDebt.debtor === "user") {
      pendingDebt.debtor = text.trim();
    } else if (pendingDebt.type === "devido" && pendingDebt.creditor === "user") {
      pendingDebt.creditor = text.trim();
    }

    try {
      await debts.insertOne({
        message_sid: messageSid,
        user_phone: from,
        type: pendingDebt.type,
        creditor: pendingDebt.creditor,
        debtor: pendingDebt.debtor,
        amount: pendingDebt.amount,
        description: pendingDebt.description,
        date: new Date(),
        settled: false,
        settled_date: null
      });
      await reply(from, "Dívida registada.");
    } catch (e) {
      if (e.code !== 11000) throw e;
      await reply(from, "Dívida registada.");
    }
    sessions[from] = { state: "IDLE" };
    return res.sendStatus(204);
  }

  // Check for debt pattern first (before transaction parsing)
  try {
    const parsedDebt = await parseDebt(text);

    if (
      parsedDebt &&
      !parsedDebt.error &&
      ["recebido", "devido"].includes(parsedDebt.type) &&
      Number.isFinite(parsedDebt.amount) &&
      typeof parsedDebt.creditor === "string" &&
      typeof parsedDebt.debtor === "string"
    ) {
      // Check if we need user input to fill in a name
      if (parsedDebt.creditor === "user" || parsedDebt.debtor === "user") {
        sessions[from] = {
          state: "AWAITING_DEBTOR_NAME",
          pendingDebt: {
            type: parsedDebt.type,
            creditor: parsedDebt.creditor,
            debtor: parsedDebt.debtor,
            amount: parsedDebt.amount,
            description: parsedDebt.description
          }
        };
        if (parsedDebt.type === "recebido") {
          await reply(from, "Quem te deve? Escreve o nome.");
        } else {
          await reply(from, "Tu deves a quem? Escreve o nome.");
        }
        return res.sendStatus(204);
      }

      // Full info available, ask for confirmation
      sessions[from] = {
        state: "AWAITING_DEBT_CONFIRMATION",
        pendingDebt: {
          type: parsedDebt.type,
          creditor: parsedDebt.creditor,
          debtor: parsedDebt.debtor,
          amount: parsedDebt.amount,
          description: parsedDebt.description
        }
      };

      const whoOwes = parsedDebt.type === "recebido" ? parsedDebt.debtor : parsedDebt.creditor;
      const debtText = parsedDebt.type === "recebido"
        ? `${whoOwes} te deve ${parsedDebt.amount}`
        : `tu deves ${parsedDebt.amount} a ${whoOwes}`;
      await reply(
        from,
        `Registar que ${debtText} Kz?\nResponde: Sim ou Não`
      );
      return res.sendStatus(204);
    }
  } catch (err) {
    console.error("Debt parsing error:", err);
    // Fall through to transaction parsing
  }

  // New transaction
  try {
    const parsed = await parseTransaction(text);

    if (
      !parsed ||
      parsed.error ||
      !["income", "expense"].includes(parsed.type) ||
      !Number.isFinite(parsed.amount) ||
      typeof parsed.description !== "string" ||
      parsed.description.trim().length === 0
    ) {
      await reply(from, "Não percebi. Reescreve a frase.");
      return res.sendStatus(204);
    }

    parsed.amount = Number(parsed.amount);
    parsed.description = parsed.description.trim();

    sessions[from] = {
      state: "AWAITING_CONFIRMATION",
      pending: parsed
    };

    await reply(
      from,
      `Registar ${parsed.type === "income" ? "entrada" : "saída"} de ${parsed.amount} Kz (${parsed.description})?\nResponde: Sim ou Não`
    );

    return res.sendStatus(204);
  } catch (err) {
    console.error(err);
    await reply(from, "Erro ao processar. Tenta novamente.");
    return res.sendStatus(204);
  }

});

app.get("/health", (_, res) => res.send("ok"));

app.listen(process.env.PORT || 3000);
