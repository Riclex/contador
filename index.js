import express from "express";
import bodyParser from "body-parser";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- Clients
const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
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
          "You are a strict financial message parser. You MUST output a JSON object with exactly these keys: type, amount, description. No other keys are allowed. If any value is missing or ambiguous, output {\"error\":\"ambiguous\"}. Portuguese language only. Examples:\n\nInput: 'Paguei 500 Kz de almoço'\nOutput: {\"type\":\"expense\",\"amount\":500,\"description\":\"almoço\"}\n\nInput: 'Recebi 2000 Kz do João'\nOutput: {\"type\":\"income\",\"amount\":2000,\"description\":\"do João\"}\n\nInput: 'Comprei pão'\nOutput: {\"error\":\"ambiguous\"}"
      },
      {
        role: "user",
        content: `Extrai uma transação financeira desta frase:\n"${text}"`
      }
    ]
  });

  const parsed = response.choices[0].message.content;
  console.log("LLM RAW:", parsed);
  
  return JSON.parse(parsed);
}

async function reply(to, body) {
  await twilioClient.messages.create({
    from: "whatsapp:+14155238886", // Twilio sandbox number
    to,
    body
  });
}

// --- Routes
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const text = normalize(req.body.Body);

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

    const total = docs.reduce((sum, t) => {
      return t.type === "income"
        ? sum + t.amount
        : sum - t.amount;
    }, 0);

    await reply(from, `Total de hoje: ${total} Kz`);
    return res.sendStatus(200);
  }

  // Awaiting confirmation
  if (session.state === "AWAITING_CONFIRMATION") {
    if (text === "sim") {
      await transactions.insertOne({
        user_phone: from,
        ...session.pending,
        date: new Date()
      });

      await reply(from, "Registado.");
    } else {
      await reply(from, "Cancelado.");
    }

    sessions[from] = { state: "IDLE" };
    return res.sendStatus(200);
  }

  // New transaction
  try {
    const parsed = await parseTransaction(text);

    if (
      !parsed.type ||
      typeof parsed.amount !== "number" ||
      !parsed.description
    ) {
    await reply(from, "Não percebi. Reescreve a frase.");
    return res.sendStatus(200);
    }

    parsed.amount = Number(parsed.amount);
    parsed.description = parsed.description.trim();
    
    session.state = "AWAITING_CONFIRMATION";
    session.pending = parsed;

    await reply(
      from,
      `Registar ${parsed.type === "income" ? "entrada" : "saída"} de ${parsed.amount} Kz (${parsed.description})?\nResponde: Sim ou Não`
    );
  } catch (err){
    console.error(err);
    await reply(from, "Erro ao processar. Tenta novamente.");
  }

  res.sendStatus(200);
});

app.get("/health", (_, res) => res.send("ok"));

app.listen(process.env.PORT || 3000);
