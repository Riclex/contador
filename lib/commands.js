// Barrel file — re-exports from domain-specific handler modules
// Kept for backward compatibility with existing test imports.
// New code should import directly from lib/handlers/*.js

export {
  COMMANDS,
  MAX_WHATSAPP_CHARS,
  handleHoje,
  handleQuemedeve,
  handleQuemdevo,
  handleKilapi,
  handlePago,
  handleStats,
  handleRetencao,
  handleAnunciar,
  handleAjuda,
  handlePrivacidade,
  handleTermos,
  handleDica,
  handleMeusdados,
  handleApagar,
  handleDesfazer,
  handleResumo,
  handleMes,
  handleFeedback,
  handleExportar,
  handleMetricas
} from './handlers/commands.js';

export {
  handleAwaitingConfirmation,
  handleAwaitingDebtConfirmation,
  handleAwaitingPagoConfirm,
  handleAwaitingDebtorName,
  handleAwaitingApagarConfirm,
  handleAwaitingDesfazerConfirm
} from './handlers/session.js';

export {
  handleDebtParse,
  handleTransactionParse
} from './handlers/parsers.js';
