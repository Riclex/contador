import express from "express";
import bodyParser from "body-parser";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import twilio from "twilio";

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- In-memory sessions
const sessions = {};

// --- Helpers
function normalize(text) {
  return text.toLowerCase().trim();
}

async function parseTransaction(text) {
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
    return res.sendStatus (204);
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

  // Awaiting confirmation
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
        // Duplicate key error, likely due to retry. Ignore
      }


      await reply(from, "Registado.");
    } else {
      await reply(from, "Cancelado.");
    }

    sessions[from] = { state: "IDLE" };
    return res.sendStatus(204);
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
