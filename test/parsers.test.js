import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  parseTransactionRegex,
  parseDebtRegex
} from '../lib/parsers.js';

// --- normalize ---
describe('normalize', () => {
  it('lowercases text', () => {
    assert.equal(normalize('Vendi 1000'), 'vendi 1000');
  });

  it('trims whitespace', () => {
    assert.equal(normalize('  vendi 1000  '), 'vendi 1000');
  });
});

// --- parseTransactionRegex: income patterns ---
describe('parseTransactionRegex - income', () => {
  it('parses "vendi 1000 de fuba"', () => {
    const result = parseTransactionRegex('vendi 1000 de fuba');
    assert.equal(result.type, 'income');
    assert.equal(result.amount, 1000);
  });

  it('parses "recebi 2000 Kz do Joao"', () => {
    const result = parseTransactionRegex('recebi 2000 Kz do Joao');
    assert.equal(result.type, 'income');
    assert.equal(result.amount, 2000);
  });

  it('parses "ganhei 500"', () => {
    const result = parseTransactionRegex('ganhei 500');
    assert.equal(result.type, 'income');
    assert.equal(result.amount, 500);
  });

  it('parses space-separated thousands (200 000)', () => {
    const result = parseTransactionRegex('vendi 200 000 de fuba');
    assert.equal(result.type, 'income');
    assert.equal(result.amount, 200000);
  });

  it('parses "paiei 3000 paus"', () => {
    const result = parseTransactionRegex('paiei 3000 paus');
    assert.equal(result.type, 'income');
    assert.equal(result.amount, 3000);
  });
});

// --- parseTransactionRegex: expense patterns ---
describe('parseTransactionRegex - expense', () => {
  it('parses "comprei 500 pao"', () => {
    const result = parseTransactionRegex('comprei 500 pao');
    assert.equal(result.type, 'expense');
    assert.equal(result.amount, 500);
  });

  it('parses "gastei 3000 com farinha"', () => {
    const result = parseTransactionRegex('gastei 3000 com farinha');
    assert.equal(result.type, 'expense');
    assert.equal(result.amount, 3000);
  });

  it('parses "paguei 500 da conta"', () => {
    const result = parseTransactionRegex('paguei 500 da conta');
    assert.equal(result.type, 'expense');
    assert.equal(result.amount, 500);
  });

  it('parses "gastei 1000 em compras"', () => {
    const result = parseTransactionRegex('gastei 1000 em compras');
    assert.equal(result.type, 'expense');
    assert.equal(result.amount, 1000);
    assert.equal(result.description, 'compras');
  });

  it('parses "gastei 50 000 em material escolar" (multi-word em description)', () => {
    const result = parseTransactionRegex('gastei 50 000 em material escolar');
    assert.equal(result.type, 'expense');
    assert.equal(result.amount, 50000);
    assert.equal(result.description, 'material escolar');
  });
});

// --- parseTransactionRegex: transfer patterns ---
describe('parseTransactionRegex - transfers', () => {
  it('"transferi 200000 para Hugo" is expense', () => {
    const result = parseTransactionRegex('transferi 200000 para Hugo');
    assert.equal(result.type, 'expense');
    assert.equal(result.amount, 200000);
  });

  it('"transferi 200 000 para a minha conta" is income', () => {
    const result = parseTransactionRegex('transferi 200 000 para a minha conta');
    assert.equal(result.type, 'income');
    assert.equal(result.amount, 200000);
  });

  it('"enviei para a minha conta 200 000" is income', () => {
    const result = parseTransactionRegex('enviei para a minha conta 200 000');
    assert.equal(result.type, 'income');
    assert.equal(result.amount, 200000);
  });
});

// --- parseTransactionRegex: emprestei (no recipient) returns ambiguous ---
describe('parseTransactionRegex - emprestei without recipient', () => {
  it('"emprestei 500 kz" returns ambiguous (no recipient known)', () => {
    const result = parseTransactionRegex('emprestei 500 kz');
    assert.equal(result.error, 'ambiguous');
  });

  it('"emprestei 500" returns ambiguous (no recipient known)', () => {
    const result = parseTransactionRegex('emprestei 500');
    assert.equal(result.error, 'ambiguous');
  });
});

// --- parseTransactionRegex: ambiguous cases ---
describe('parseTransactionRegex - ambiguous', () => {
  it('returns ambiguous when no verb is present', () => {
    const result = parseTransactionRegex('1000 kz de fuba');
    assert.equal(result.error, 'ambiguous');
  });

  it('returns ambiguous when no amount is present', () => {
    const result = parseTransactionRegex('vendi pao');
    assert.equal(result.error, 'ambiguous');
  });

  it('returns ambiguous when amount exceeds 1 billion', () => {
    const result = parseTransactionRegex('vendi 2000000000');
    assert.equal(result.error, 'ambiguous');
  });

  it('returns ambiguous when amount is zero', () => {
    const result = parseTransactionRegex('vendi 0');
    assert.equal(result.error, 'ambiguous');
  });
});

// --- parseDebtRegex: recebido (someone owes user) ---
describe('parseDebtRegex - recebido', () => {
  it('"O Joao me deve 2000kz"', () => {
    const result = parseDebtRegex('O Joao me deve 2000kz');
    assert.equal(result.type, 'recebido');
    assert.equal(result.creditor, 'user');
    assert.equal(result.debtor, 'joao');
    assert.equal(result.amount, 2000);
  });

  it('"O Joao me deve 200 000 kz" (space-separated thousands)', () => {
    const result = parseDebtRegex('O Joao me deve 200 000 kz');
    assert.equal(result.type, 'recebido');
    assert.equal(result.amount, 200000);
  });

  it('"Me deve 2000 ao Joao" (name after "ao")', () => {
    const result = parseDebtRegex('Me deve 2000 ao Joao');
    assert.equal(result.type, 'recebido');
    assert.equal(result.creditor, 'user');
    assert.equal(result.debtor, 'joao');
    assert.equal(result.amount, 2000);
  });
});

// --- parseDebtRegex: devido (user owes someone) ---
describe('parseDebtRegex - devido', () => {
  it('"Eu devo 1500 ao Maria"', () => {
    const result = parseDebtRegex('Eu devo 1500 ao Maria');
    assert.equal(result.type, 'devido');
    assert.equal(result.creditor, 'maria');
    assert.equal(result.debtor, 'user');
    assert.equal(result.amount, 1500);
  });

  it('"Devo 1500 a Maria"', () => {
    const result = parseDebtRegex('Devo 1500 a Maria');
    assert.equal(result.type, 'devido');
    assert.equal(result.creditor, 'maria');
    assert.equal(result.debtor, 'user');
    assert.equal(result.amount, 1500);
  });
});

// --- parseDebtRegex: emprestei with recipient = recebido ---
describe('parseDebtRegex - emprestei', () => {
  it('"Emprestei 500 ao Joao" is recebido (user lent, expects return)', () => {
    const result = parseDebtRegex('Emprestei 500 ao Joao');
    assert.equal(result.type, 'recebido');
    assert.equal(result.creditor, 'user');
    assert.equal(result.debtor, 'joao');
    assert.equal(result.amount, 500);
  });
});

// --- parseDebtRegex: separation (non-debt patterns return ambiguous) ---
describe('parseDebtRegex - separation from transactions', () => {
  it('"Vendi 1000 Kz de fuba" returns ambiguous (not a debt)', () => {
    const result = parseDebtRegex('Vendi 1000 Kz de fuba');
    assert.equal(result.error, 'ambiguous');
  });

  it('"Comprei pao" returns ambiguous (not a debt)', () => {
    const result = parseDebtRegex('Comprei pao');
    assert.equal(result.error, 'ambiguous');
  });

  it('"Transferi 50000 para Maria" returns ambiguous (not a debt)', () => {
    const result = parseDebtRegex('Transferi 50000 para Maria');
    assert.equal(result.error, 'ambiguous');
  });
});