import { hashPhone, OnboardingState } from './security.js';

export async function sendWelcomeMessage(replyWithRetry, userPhone) {
  const welcomeMessage = `Boas! 👋 Sou o Contador, o teu assistente financeiro no WhatsApp.

Regista vendas, gastos e kilapis só mandando mensagens.

Exemplos:
• "vendi 5000 de pão"
• "João me deve 2000"
• "hoje" (vê saldo)

📄 Termos: /termos
🔒 Privacidade: /privacidade

Aceitas que guardemos os teus dados para fazer os cálculos? Responde "sim" para continuar.`;

  await replyWithRetry(userPhone, welcomeMessage);
}

export async function setOnboardingState(db, userPhone, state) {
  const userHash = hashPhone(userPhone);
  await db.collection('onboarding').updateOne(
    { user_hash: userHash },
    { $set: { state, updated_at: new Date() } },
    { upsert: true }
  );
  if (state === OnboardingState.COMPLETED) {
    await db.collection('broadcast_list').updateOne(
      { user_hash: userHash },
      { $set: { phone: userPhone, updated_at: new Date() } },
      { upsert: true }
    );
  }
}

export function normalizeOnboardingState(state) {
  if (state === 'awaiting_consent') return 'AWAITING_CONSENT';
  if (state === 'completed') return 'COMPLETED';
  return state;
}

export async function getOnboardingState(db, userPhone) {
  const userHash = hashPhone(userPhone);
  const doc = await db.collection('onboarding').findOne({ user_hash: userHash });
  return normalizeOnboardingState(doc?.state) || null;
}
