/**
 * OpenAI mock response map for integration tests.
 *
 * When NODE_ENV=test and OPENAI_MOCK_RESPONSE=true, lib/openai.js
 * returns predefined responses instead of calling the OpenAI API.
 *
 * Add entries for specific input texts that the test exercises.
 */
export const MOCK_RESPONSES = new Map([
  // Transaction: regex-ambiguous, resolved by OpenAI
  ['passei 3000 kz no mercado', JSON.stringify({
    type: 'expense',
    amount: 3000,
    description: 'mercado'
  })],
  // Debt: regex-ambiguous "deve" pattern without standard structure
  ['o zé deve 2500 paus do bolo', JSON.stringify({
    type: 'recebido',
    creditor: 'user',
    debtor: 'zé',
    amount: 2500,
    description: 'bolo'
  })],
  // Generic ambiguous — OpenAI also can't resolve
  ['qualquer coisa', JSON.stringify({
    error: 'ambiguous'
  })],
]);
