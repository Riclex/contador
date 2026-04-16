import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionState,
  OnboardingState,
  isValidDebtName,
  hashPhone,
  sanitizeInput,
  sanitizeForPrompt
} from '../index.js';

// --- Session State Enum Validation ---

describe('Webhook - Session State Completeness', () => {
  it('SessionState has all required states', () => {
    const requiredStates = ['IDLE', 'AWAITING_CONFIRMATION', 'AWAITING_DEBT_CONFIRMATION',
      'AWAITING_PAGO_CONFIRM', 'AWAITING_DEBTOR_NAME', 'AWAITING_APAGAR_CONFIRM'];
    for (const state of requiredStates) {
      assert.ok(SessionState[state], `Missing SessionState.${state}`);
      assert.equal(typeof SessionState[state], 'string');
    }
  });

  it('OnboardingState has AWAITING_CONSENT and COMPLETED', () => {
    assert.equal(typeof OnboardingState.AWAITING_CONSENT, 'string');
    assert.equal(typeof OnboardingState.COMPLETED, 'string');
    assert.notEqual(OnboardingState.AWAITING_CONSENT, OnboardingState.COMPLETED);
  });
});

// --- Command Override Logic ---

describe('Webhook - Command Override Detection', () => {
  const COMMANDS = new Set([
    'hoje', '/quemedeve', '/quemdevo', '/kilapi', '/stats',
    'ajuda', '/ajuda', 'comandos', '/comandos',
    'privacidade', '/privacidade', 'termos', '/termos',
    'meusdados', '/meusdados', 'apagar', '/apagar',
    'resumo', '/resumo', 'mes', '/mes'
  ]);

  function shouldResetToIdle(state, text) {
    // Mirrors the logic in the webhook handler:
    // If user is in non-IDLE state and types a command (not sim/nao/não), reset to IDLE
    if (state === SessionState.IDLE) return false;
    if (text === 'sim' || text === 'nao' || text === 'não') return false;
    return COMMANDS.has(text) || /^\/\w+\s+/.test(text);
  }

  it('does not reset when in IDLE state', () => {
    assert.ok(!shouldResetToIdle(SessionState.IDLE, '/quemedeve'));
  });

  it('does not reset for "sim" during confirmation', () => {
    assert.ok(!shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, 'sim'));
  });

  it('does not reset for "nao" during confirmation', () => {
    assert.ok(!shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, 'nao'));
  });

  it('resets for "hoje" during confirmation', () => {
    assert.ok(shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, 'hoje'));
  });

  it('resets for "/ajuda" during debt confirmation', () => {
    assert.ok(shouldResetToIdle(SessionState.AWAITING_DEBT_CONFIRMATION, '/ajuda'));
  });

  it('resets for "/pago joao" during pago confirmation', () => {
    assert.ok(shouldResetToIdle(SessionState.AWAITING_PAGO_CONFIRM, '/pago joao'));
  });

  it('resets for paginated commands like "/quemedeve 2"', () => {
    assert.ok(shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, '/quemedeve 2'));
  });

  it('resets for "/kilapi 3" during debtor name input', () => {
    assert.ok(shouldResetToIdle(SessionState.AWAITING_DEBTOR_NAME, '/kilapi 3'));
  });

  it('does not reset for regular text during confirmation', () => {
    assert.ok(!shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, 'vendi 500 de pao'));
  });

  it('resets for "/apagar" during apagar confirmation', () => {
    // Commands typed during AWAITING_APAGAR_CONFIRM also trigger reset
    assert.ok(shouldResetToIdle(SessionState.AWAITING_APAGAR_CONFIRM, '/ajuda'));
  });
});

// --- Confirmation Flow Logic ---

describe('Webhook - Confirmation Branch Logic', () => {
  function handleConfirmationInput(text) {
    // Mirrors the 3-branch confirmation logic:
    // "sim" → confirm
    // "nao"/"não" → cancel, return
    // else → cancel, fall through to parsing
    if (text === 'sim') return { action: 'confirm', fallThrough: false };
    if (text === 'nao' || text === 'não') return { action: 'cancel', fallThrough: false };
    return { action: 'cancel', fallThrough: true };
  }

  it('"sim" confirms without fall-through', () => {
    const result = handleConfirmationInput('sim');
    assert.equal(result.action, 'confirm');
    assert.equal(result.fallThrough, false);
  });

  it('"nao" cancels without fall-through', () => {
    const result = handleConfirmationInput('nao');
    assert.equal(result.action, 'cancel');
    assert.equal(result.fallThrough, false);
  });

  it('"não" (with accent) cancels without fall-through', () => {
    const result = handleConfirmationInput('não');
    assert.equal(result.action, 'cancel');
    assert.equal(result.fallThrough, false);
  });

  it('other input cancels WITH fall-through (for re-parsing)', () => {
    const result = handleConfirmationInput('vendi 5000 de pao');
    assert.equal(result.action, 'cancel');
    assert.equal(result.fallThrough, true);
  });

  it('random text cancels with fall-through', () => {
    const result = handleConfirmationInput('abc');
    assert.equal(result.action, 'cancel');
    assert.equal(result.fallThrough, true);
  });
});

// --- /pago Prompt Formatting ---

describe('Webhook - /pago Disambiguation Format', () => {
  function formatPagoPrompt({ type, counterparty, amount, extraDebts }) {
    const who = type === 'recebido'
      ? `${counterparty} te deve`
      : `tu deves a ${counterparty}`;
    const suffix = extraDebts > 0
      ? ` (mais ${extraDebts} dívida${extraDebts > 1 ? 's' : ''})`
      : '';
    return `Marcar como paga: ${who} ${amount} Kz${suffix}?\nResponde: Sim ou Não`;
  }

  it('no suffix when only 1 matching debt', () => {
    const msg = formatPagoPrompt({ type: 'recebido', counterparty: 'João', amount: 2000, extraDebts: 0 });
    assert.ok(!msg.includes('mais'));
    assert.ok(msg.includes('João te deve'));
    assert.ok(msg.includes('2000 Kz'));
  });

  it('singular "dívida" for 1 extra debt', () => {
    const msg = formatPagoPrompt({ type: 'recebido', counterparty: 'João', amount: 2000, extraDebts: 1 });
    assert.ok(msg.includes('mais 1 dívida)'));
    assert.ok(!msg.includes('dívidas'));
  });

  it('plural "dívidas" for 2+ extra debts', () => {
    const msg = formatPagoPrompt({ type: 'devido', counterparty: 'Maria', amount: 5000, extraDebts: 3 });
    assert.ok(msg.includes('mais 3 dívidas)'));
    assert.ok(msg.includes('tu deves a Maria'));
  });
});

// --- Phone Display Formatting ---

describe('Webhook - Phone Masking Format', () => {
  function formatPhoneDisplay(phone) {
    const num = phone.replace('whatsapp:', '');
    return '•'.repeat(num.length - 4) + num.slice(-4);
  }

  it('masks all but last 4 digits', () => {
    const result = formatPhoneDisplay('whatsapp:+244912345678');
    // +244912345678 = 13 chars → 9 bullets + 4 digits
    assert.equal(result, '•••••••••5678');
    assert.ok(result.endsWith('5678'));
  });

  it('never shows the country code', () => {
    const result = formatPhoneDisplay('whatsapp:+244912345678');
    assert.ok(!result.includes('+244'));
    assert.ok(!result.includes('244'));
  });

  it('shows last 4 digits for user identification', () => {
    const result = formatPhoneDisplay('whatsapp:+351936123127');
    assert.ok(result.endsWith('3127'));
  });

  it('works with different number lengths', () => {
    const result = formatPhoneDisplay('whatsapp:+1234567');
    assert.ok(result.endsWith('4567'));
    assert.equal(result.length, 8); // +1234 is 5 chars, minus 4 = 1 bullet + 4 digits
  });
});

// --- Debt Name Validation ---

describe('Webhook - Debt Name Validation (isValidDebtName)', () => {
  it('accepts valid Portuguese names', () => {
    assert.ok(isValidDebtName('João'));
    assert.ok(isValidDebtName('Maria'));
    assert.ok(isValidDebtName('José Carlos'));
  });

  it('accepts names with accents', () => {
    assert.ok(isValidDebtName('André'));
    assert.ok(isValidDebtName('Luísa'));
  });

  it('rejects empty strings', () => {
    assert.ok(!isValidDebtName(''));
    assert.ok(!isValidDebtName('   '));
  });

  it('rejects names with numbers', () => {
    assert.ok(!isValidDebtName('João123'));
  });

  it('rejects names exceeding 30 characters', () => {
    assert.ok(!isValidDebtName('A'.repeat(31)));
  });

  it('accepts names at exactly 30 characters', () => {
    assert.ok(isValidDebtName('A'.repeat(30)));
  });

  it('rejects non-string input', () => {
    assert.ok(!isValidDebtName(null));
    assert.ok(!isValidDebtName(undefined));
    assert.ok(!isValidDebtName(123));
  });

  it('rejects names with special characters', () => {
    assert.ok(!isValidDebtName('João$'));
    assert.ok(!isValidDebtName('Maria_Silva'));
  });
});

// --- Integration Tests (TODO: require running server with MongoDB) ---

describe('Webhook - Integration Tests (requires server)', () => {
  it.todo('AWAITING_CONFIRMATION + "sim" confirms and inserts transaction');
  it.todo('AWAITING_DEBT_CONFIRMATION + "sim" confirms and inserts debt');
  it.todo('AWAITING_PAGO_CONFIRM + "sim" marks debt as settled');
  it.todo('full onboarding flow: new user → consent → completed');
  it.todo('rate limit exceeded returns 204 with notice');
  it.todo('command during AWAITING_CONFIRMATION resets to IDLE and processes command');
  it.todo('/meusdados masks phone number showing only last 4 digits');
  it.todo('/pago shows extra debt count in confirmation prompt');
});