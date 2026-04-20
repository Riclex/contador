# Política de Privacidade - Contador

**Última atualização:** 15 de Abril de 2026

## 1. Introdução

O **Contador** é um assistente financeiro via WhatsApp que permite aos usuários registrar vendas, gastos e dívidas usando linguagem natural em Português. Esta Política de Privacidade explica como coletamos, usamos, armazenamos e protegemos seus dados pessoais em conformidade com a Lei da Protecção de Dados Pessoais de Angola (Lei nº 22/11).

## 2. Dados Coletados

### 2.1 Dados que Coletamos

| Dado | Finalidade | Base Legal |
|------|------------|------------|
| **Número de telefone WhatsApp** (armazenado com hash SHA-256 em todas as coleções, incluindo limitação de uso) | Identificação única do usuário / Prevenção de abuso | Consentimento / Interesse legítimo (limitação de uso) |
| **Transações** (vendas, gastos, descrições) | Fornecer resumos de saldo e histórico | Consentimento |
| **Dívidas** (credor, devedor, valores, descrições) | Rastrear e gerenciar dívidas | Consentimento |
| **Eventos de auditoria** (primeiro uso, consentimento, mensagens enviadas) | Compliance e segurança | Legítimo interesse |

### 2.2 Dados que NÃO Coletamos

- Nome completo do usuário
- Endereço ou localização
- Informações bancárias ou de cartão de crédito
- Credenciais de login ou senhas
- Dados de menores de idade

## 3. Finalidade do Processamento de Dados

Seus dados são processados exclusivamente para:

1. **Fornecer o serviço solicitado:**
   - Calcular saldos diários, semanais e mensais (`hoje`, `resumo`, `mes`)
   - Rastrear dívidas (`/quemedeve`, `/quemdevo`, `/kilapi`)
   - Manter histórico de transações

2. **Garantir segurança e conformidade:**
   - Registro de eventos de auditoria
   - Prevenção de uso indevido (rate limiting)
   - Verificação de consentimento

3. **Melhorar o serviço:**
   - Análise de padrões de uso (dados anonimizados)
   - Correção de bugs e otimização de performance

## 4. Base Legal (Lei 22/11)

O processamento de dados pessoais no Contador é baseado em:

### 4.1 Consentimento Explícito
- **Artigo 11º da Lei 22/11**: O tratamento de dados pessoais é lícito quando o titular der o seu consentimento livre, específico, informado e inequívoco.
- **Como obtemos:** Através do fluxo de onboarding onde o usuário deve responder "sim" para aceitar o armazenamento de dados.
- **Revogação:** O usuário pode retirar o consentimento a qualquer momento através do comando `/apagar`.

### 4.2 Direitos do Titular dos Dados

Nos termos da Lei 22/11, você tem direito a:

| Direito | Como Exercer |
|---------|--------------|
| **Acesso** | Comando `/meusdados` - visualiza todos os dados armazenados |
| **Retificação** | Envie mensagens corrigindo informações incorretas |
| **Eliminação (Direito ao Esquecimento)** | Comando `/apagar` - deleta permanentemente todos os dados |
| **Oposição** | Comando `/apagar` - cessa todo processamento de dados |
| **Portabilidade** | Comando `/exportar` - exporta todos os dados diretamente no bot |

## 5. Armazenamento de Dados

### 5.1 Local de Armazenamento

Os dados são armazenados no **MongoDB Atlas** com servidores localizados na **União Europeia (Frankfurt, Alemanha / Zurique, Suíça)**. Esta localização foi escolhida por:

- Possuir legislação de proteção de dados considerada adequada (GDPR)
- Garantir níveis elevados de segurança física e lógica
- Cumprir requisitos de transferência internacional de dados

### 5.2 Período de Retenção

| Tipo de Dado | Período de Retenção |
|--------------|---------------------|
| Dados de transações e dívidas | Até solicitação de exclusão via `/apagar` |
| Eventos de auditoria | 2 anos após exclusão da conta (eliminação automática via índice TTL) |
| Registos de limitação de uso (rate limits) | Eliminados automaticamente após 24h ou ao usar `/apagar` |
| Sessões de usuário | 30 minutos após última atividade |
| Cache de respostas | 24 horas |

### 5.3 Medidas de Segurança

Implementamos as seguintes medidas técnicas e organizacionais:

- **Pseudonimização:** Números de telefone armazenados exclusivamente com hash SHA-256 em todas as coleções (transações, dívidas, eventos, sessões e onboarding)
- **Criptografia em trânsito:** HTTPS/TLS para todas as comunicações
- **Verificação de assinatura:** Validação SHA256 obrigatória de webhooks Twilio (sem caminho de bypass)
- **Sanitização de input:** Remoção de caracteres de controle, caracteres de largura zero e overrides direcionais Unicode
- **Rate limiting:** 50 mensagens/usuário/dia para prevenir abuso; registos eliminados ao usar `/apagar`
- **Gestão de sessão:** Sessões com TTL de 30 minutos, armazenadas com hash (nunca em texto claro)
- **Eliminação atômica:** O comando `/apagar` deleta todos os dados de forma atômica (transação MongoDB), incluindo transações, dívidas, eventos, sessões e registos de limitação de uso
- **Cabeçalhos de segurança HTTP:** Middleware `helmet` para proteção contra vulnerabilidades web comuns

## 6. Partilha de Dados

### 6.1 Terceiros com Acesso a Dados

| Terceiro | Finalidade | Base Legal |
|----------|------------|------------|
| **Twilio Inc.** (WhatsApp API) | Entrega de mensagens | Execução do contrato |
| **OpenAI LLC** (GPT-4o-mini) | Processamento de linguagem natural | Execução do contrato |
| **MongoDB Inc.** (Atlas) | Armazenamento de dados | Execução do contrato |

### 6.2 Dados NÃO São Vendidos

O Contador **NÃO vende, aluga ou comercializa** dados pessoais com terceiros para fins de marketing ou publicidade.

### 6.3 Transferências Internacionais

Os dados podem ser transferidos para fora de Angola para:
- Estados Unidos (Twilio, OpenAI)
- União Europeia (MongoDB Atlas)

Estas transferências são necessárias para a prestação do serviço e contam com garantias contratuais adequadas.

## 7. Como Exercer Seus Direitos

### 7.1 Comandos Diretos no Bot

| Comando | Ação |
|---------|------|
| `/meusdados` | Visualizar todos os dados armazenados |
| `/exportar` | Exportar todos os dados para portabilidade |
| `/apagar` | Deletar permanentemente todos os dados de forma atômica (incluindo registos de limitação de uso) |

### 7.2 Contato com a Administração

Para solicitações que não possam ser resolvidas via comandos, entre em contato:

- **GitHub Issues:** https://github.com/contador-app/contador/issues
- **Email:** rickoalex@gmail.com

## 8. Alterações a Esta Política

Podemos atualizar esta Política de Privacidade periodicamente. Alterações significativas serão comunicadas aos usuários ativos através do bot.

## 9. Lei Aplicável

Esta Política de Privacidade é regida pela **Lei nº 22/11 de 17 de Junho - Lei da Protecção de Dados Pessoais da República de Angola**.

## 10. Autoridade de Supervisão

Em caso de violação de dados pessoais, os usuários podem apresentar reclamação à **Agência de Protecção de Dados Pessoais de Angola** (quando estabelecida).

---

**Contador** - Assistente Financeiro via WhatsApp
*Desenvolvido com foco em privacidade e conformidade*
