import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { WagerTransaction, type CreateWagerProps, type WagerKind } from '../../src/domain/wager-transaction';
import { DomainError } from '../../src/domain/errors';
import { payloadHash, type WagerPayload } from '../../src/domain/payload-hash';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-21T12:00:00.000Z');
function error(code: string): (cause: unknown) => boolean {
  return (cause) => cause instanceof DomainError && cause.code === code;
}
function wallet(amount = '100.00'): Wallet {
  return Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: brl(amount), at });
}
function wager(kind: WagerKind, extra: Partial<CreateWagerProps> = {}): WagerTransaction {
  return WagerTransaction.create({ id: kind, providerId: 'provider', externalTransactionId: kind,
    idempotencyKey: `provider:${kind}`, payloadHash: 'a'.repeat(64), walletId: 'wallet', playerId: 'player',
    roundId: 'round', gameId: 'game', kind, money: brl('25.00'), createdAt: at,
    ...(kind === 'REFUND' || kind === 'ROLLBACK' ? { referenceExternalTransactionId: 'BET' } : {}), ...extra });
}
function processed(kind: WagerKind, extra: Partial<CreateWagerProps> = {}): WagerTransaction {
  const value = wager(kind, extra);
  value.markProcessed(value.requiresReference() ? 'reference-id' : undefined, at);
  return value;
}

test('Money: soma/subtração exatas, sem arredondamento e sem mutação', () => {
  const first = brl('0.10');
  assert.equal(first.add(brl('0.20')).toString(), '0.30');
  assert.equal(first.toString(), '0.10');
  assert.equal(brl('9007199254740993.01').add(brl('0.01')).toString(), '9007199254740993.02');
  assert.equal(brl('1').subtract(brl('2.05')).toString(), '-1.05');
  assert.equal(brl('25.5').toString(), '25.50');
  assert.deepEqual(brl('25').toJSON(), { amount: '25.00', currency: 'BRL' });
  assert.equal(JSON.stringify(brl('25')), '{"amount":"25.00","currency":"BRL"}');
  assert.ok(Object.isFrozen(first));
});

for (const amount of ['', ' ', 'NaN', 'Infinity', '1e2', '1.001', '1.005', '-1.00', '-0.00', '+1', '.5', '1.', '1,00', '0x10']) {
  test(`Money: rejeita entrada ${JSON.stringify(amount)}`, () => {
    assert.throws(() => brl(amount), error('INVALID_MONEY'));
  });
}
test('Money: tipos de entrada, moeda e limite válidos', () => {
  assert.throws(() => brl(1 as unknown as string), error('INVALID_MONEY'));
  assert.throws(() => Money.from({ amount: '1', currency: 'XYZ' }), error('INVALID_MONEY'));
  assert.throws(() => Money.from({ amount: '1', currency: 'brl' }), error('INVALID_MONEY'));
  assert.equal(brl('9999999999999999999999999999.99').toString(), '9999999999999999999999999999.99');
  assert.throws(() => brl('9999999999999999999999999999.99').add(brl('0.01')), error('INVALID_MONEY'));
});
test('Money: sinais, zero, comparações e moedas diferentes', () => {
  assert.ok(brl('0').isZero());
  assert.ok(brl('2').isPositive());
  assert.ok(brl('2').negate().isNegative());
  assert.ok(brl('2').isLessThan(brl('3')));
  assert.ok(brl('2').equals(brl('2.00')));
  assert.equal(Money.rehydrate({ amount: '-0.01', currency: 'BRL' }).toString(), '-0.01');
  const usd = Money.from({ amount: '2', currency: 'USD' });
  for (const operation of [() => brl('2').add(usd), () => brl('2').subtract(usd),
    () => brl('2').isLessThan(usd), () => brl('2').equals(usd)]) {
    assert.throws(operation, error('CURRENCY_MISMATCH'));
  }
});
test('Wallet: abertura positiva gera crédito e mantém version 1; zero não gera ledger', () => {
  const value = wallet();
  const entry = value.openingEntry({ entryId: 'entry', transactionId: 'opening' });
  assert.equal(value.version, 1);
  assert.equal(entry?.direction, 'CREDIT');
  assert.equal(entry?.balanceBefore.toString(), '0.00');
  assert.equal(entry?.balanceAfter.toString(), '100.00');
  assert.equal(wallet('0').openingEntry({ entryId: 'entry', transactionId: 'opening' }), undefined);
  assert.throws(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1').negate() }), error('INVALID_AMOUNT'));
});
test('Wallet: movimento e ledger consistentes; falha preserva saldo/version', () => {
  const value = wallet();
  const entry = value.debit({ entryId: 'entry', transactionId: 'bet', money: brl('80'), at });
  assert.equal(entry.balanceBefore.toString(), '100.00');
  assert.equal(entry.balanceAfter.toString(), '20.00');
  assert.ok(entry.isBalanced());
  assert.equal(value.version, 2);
  assert.throws(() => value.debit({ entryId: 'x', transactionId: 'bet2', money: brl('80'), at }), error('INSUFFICIENT_FUNDS'));
  assert.equal(value.balance.toString(), '20.00');
  assert.equal(value.version, 2);
  assert.throws(() => value.debit({ entryId: 'x', transactionId: 'rollback', money: brl('80'), at }, true), error('REVERSAL_INSUFFICIENT_FUNDS'));
  value.credit({ entryId: 'y', transactionId: 'win', money: brl('5'), at });
  assert.equal(value.balance.toString(), '25.00');
  assert.equal(value.version, 3);
  assert.throws(() => value.credit({ entryId: 'y', transactionId: 'z', money: brl('0'), at }), error('INVALID_AMOUNT'));
  assert.throws(() => value.credit({ entryId: 'y', transactionId: 'z', money: Money.from({ amount: '5', currency: 'USD' }), at }), error('CURRENCY_MISMATCH'));
});
test('Wallet: rehydrate mantém versão e cópias de datas', () => {
  const value = Wallet.rehydrate({ id: 'w', playerId: 'p', balance: brl('15'), version: 9, createdAt: at, updatedAt: at });
  value.createdAt.setFullYear(2000);
  assert.equal(value.createdAt.toISOString(), at.toISOString());
  assert.equal(value.version, 9);
});
test('Ledger: factory rejeita aritmética inválida e moeda divergente; getters imutáveis', () => {
  const state = { id: 'e', walletId: 'w', transactionId: 't', direction: 'DEBIT' as const,
    money: brl('10'), balanceBefore: brl('20'), balanceAfter: brl('15'), createdAt: at };
  assert.throws(() => WalletLedgerEntry.create(state), error('INVALID_AMOUNT'));
  assert.throws(() => WalletLedgerEntry.create({ ...state, balanceAfter: Money.from({ amount: '10', currency: 'USD' }) }), error('CURRENCY_MISMATCH'));
  const entry = WalletLedgerEntry.create({ ...state, balanceAfter: brl('10') });
  assert.ok(Object.isFrozen(entry));
  entry.createdAt.setFullYear(2000);
  assert.equal(entry.createdAt.toISOString(), at.toISOString());
});
test('Transação: BET, WIN, LOSS, REFUND e ROLLBACK têm direções esperadas', () => {
  assert.equal(wager('BET').ledgerDirectionFor(), 'DEBIT');
  assert.equal(wager('WIN').ledgerDirectionFor(), 'CREDIT');
  const loss = wager('LOSS');
  assert.equal(loss.affectsBalance(), false);
  assert.throws(() => loss.ledgerDirectionFor(), error('INVALID_TRANSACTION_STATE'));
  assert.equal(wager('REFUND').ledgerDirectionFor(processed('BET')), 'CREDIT');
  assert.equal(wager('ROLLBACK').ledgerDirectionFor(processed('BET')), 'CREDIT');
  assert.equal(wager('ROLLBACK', { referenceExternalTransactionId: 'WIN' }).ledgerDirectionFor(processed('WIN')), 'DEBIT');
  assert.equal(wager('ROLLBACK', { referenceExternalTransactionId: 'REFUND' }).ledgerDirectionFor(processed('REFUND')), 'DEBIT');
});
test('Transação: referência obrigatória e compatibilidade de todos os campos de negócio', () => {
  assert.throws(() => wager('REFUND', { referenceExternalTransactionId: undefined }), error('INVALID_REFERENCE'));
  assert.throws(() => wager('ROLLBACK').ledgerDirectionFor(), error('INVALID_REFERENCE'));
  for (const extra of [{ providerId: 'other' }, { playerId: 'other' }, { walletId: 'other' },
    { roundId: 'other' }, { money: brl('20') }, { money: Money.from({ amount: '25', currency: 'USD' }) }]) {
    assert.throws(() => wager('REFUND').validateReference(processed('BET', extra)), error('INVALID_REFERENCE'));
  }
  assert.throws(() => wager('REFUND', { referenceExternalTransactionId: 'WIN' }).validateReference(processed('WIN')), error('INVALID_REFERENCE'));
  assert.throws(() => wager('REFUND').validateReference(wager('BET')), error('REFERENCE_NOT_PROCESSED'));
});
for (const terminal of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
  test(`Transação: estado ${terminal} é terminal`, () => {
    const value = wager('BET');
    if (terminal === 'PROCESSED') value.markProcessed(undefined, at);
    if (terminal === 'REJECTED') value.reject('INSUFFICIENT_FUNDS');
    if (terminal === 'FAILED') value.fail('REFERENCE_NOT_FOUND');
    assert.ok(value.isTerminal());
    assert.throws(() => value.markProcessed(undefined, at), error('INVALID_TRANSACTION_STATE'));
    assert.throws(() => value.markPendingReference(), error('INVALID_TRANSACTION_STATE'));
    assert.throws(() => value.reject('INVALID_REFERENCE'), error('INVALID_TRANSACTION_STATE'));
    assert.throws(() => value.fail('INVALID_REFERENCE'), error('INVALID_TRANSACTION_STATE'));
  });
}
test('Transação: pendência pode ser reprocessada sem aplicar transição na reidratação', () => {
  const value = wager('REFUND');
  value.markPendingReference();
  assert.equal(value.status, 'PENDING_REFERENCE');
  value.markProcessed('BET', at);
  assert.equal(value.referenceTransactionId, 'BET');
  assert.equal(value.status, 'PROCESSED');
  assert.throws(() => wager('BET').markPendingReference(), error('INVALID_REFERENCE'));
});
test('Hash: ordem de campos, escala normalizada e metadados; divergência é conflito', () => {
  const input: WagerPayload = { providerId: 'p', externalTransactionId: 'e', playerId: 'player', walletId: 'wallet',
    roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '25', currency: 'BRL' } };
  const hash = payloadHash(input);
  assert.equal(hash.length, 64);
  const reordered = { ...Object.fromEntries(Object.entries(input).reverse()),
    money: { currency: 'BRL', amount: '25.00' }, idempotencyKey: 'not-hashed', messageId: 'not-hashed' };
  assert.equal(payloadHash(reordered as unknown as WagerPayload), hash);
  assert.notEqual(payloadHash({ ...input, roundId: 'other' }), hash);
  const value = wager('BET', { payloadHash: hash });
  value.assertMatchingPayload(hash);
  assert.throws(() => value.assertMatchingPayload(payloadHash({ ...input, money: { amount: '26', currency: 'BRL' } })), error('IDEMPOTENCY_CONFLICT'));
});
