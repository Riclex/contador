import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDebtRegex, parseTransactionRegex, EXPENSE_VERBS } from '../lib/parsers.js';

describe('emprestei classification', () => {
  it('"emprestei 500 ao Joao" is a debt (recebido) via parseDebtRegex', () => {
    const result = parseDebtRegex('emprestei 500 ao João');
    assert.equal(result.type, 'recebido');
    assert.equal(result.creditor, 'user');
    assert.equal(result.debtor, 'joão');
    assert.equal(result.amount, 500);
  });

  it('"emprestei 500 kz" returns ambiguous from parseTransactionRegex', () => {
    const result = parseTransactionRegex('emprestei 500 kz');
    assert.equal(result.error, 'ambiguous');
  });

  it('"emprestei 500" returns ambiguous from parseTransactionRegex', () => {
    const result = parseTransactionRegex('emprestei 500');
    assert.equal(result.error, 'ambiguous');
  });

  it('emprestei is NOT in EXPENSE_VERBS', () => {
    assert.ok(!EXPENSE_VERBS.includes('emprestei'), 'emprestei should not be in EXPENSE_VERBS');
  });
});