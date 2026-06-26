// Angola-localized financial tips. General guidance (education), not advice.
// On-demand only — returned by /dica, never pushed. Zero OpenAI cost.
// Keep each tip <= ~280 chars for clean WhatsApp rendering.

export const TIPS = [
  { id: 'fluxo-1', category: 'fluxo', text: 'Separa o dinheiro da vendinha do teu dinheiro pessoal. Mesmo que sejas tu a gerir os dois, misturá-los é o jeito mais rápido de não saberes se o negócio está a dar lucro.' },
  { id: 'fluxo-2', category: 'fluxo', text: 'Conta tudo o que entra e sai, mesmo os 200 Kz da garrafa. São os pequenos valores, somados, que mostram a verdade da tua semana.' },
  { id: 'poupanca-1', category: 'poupanca', text: 'Guarda pelo menos uma pequena parte de cada dia de venda, mesmo que sejam só 500 Kz. A poupança não começa com valor grande, começa com o hábito.' },
  { id: 'poupanca-2', category: 'poupanca', text: 'Tenta separar o dinheiro em três: gastar (casa), investir (negócio), guardar (emergência). Mesmo com valores pequenos, a regra 50/30/20 adaptada funciona.' },
  { id: 'fiados-1', category: 'fiados', text: 'O fiado é uma venda, não um favor. Regista quem deve, quanto e quando. O que não está registado, raramente é cobrado a tempo.' },
  { id: 'fiados-2', category: 'fiados', text: 'Antes de emprestar outra vez, vê se a pessoa já saldous o que te devia da última. Quem não pagou uma vez, raramente paga duas.' },
  { id: 'kwanza-1', category: 'kwanza', text: 'O Kwanza muda de valor com o tempo. Por isso, dinheiro parado na gaveta perde força. O que poupas, procura um lugar que ao menos acompanhe a inflação.' },
  { id: 'digital-1', category: 'digital', text: 'Unitel Money e Multicaixa Express têm custos por operação. Sabe quanto cobram por transferir e por levantar — esses centavos, repetidos, pesam no fim do mês.' },
  { id: 'digital-2', category: 'digital', text: 'Faz as transferências de valor mais alto em horário seguro e guarda o comprovativo. O registo no bot não substitui o comprovativo, mas ajuda quando há litígio.' },
  { id: 'habito-1', category: 'habito', text: 'Define um dia fixo da semana para fazeres o teu resumo (ex.: domingo à noite). Revisar com regularidade vale mais do que rever com perfeição.' },
  { id: 'habito-2', category: 'habito', text: 'Se não conseguides registar logo, manda a mensagem ao bot ainda no balcão. A memória de 5 minutos é mais fiel do que a do fim do dia.' },
  { id: 'negocio-1', category: 'negocio', text: 'Saber quanto vendes não é o mesmo que saber quanto ganhas. Retira as despesas e o que reinvestes para ver o lucro real — é ele que diz se vale a pena continuar.' },
];

export function getRandomTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}