import {DomainError} from './errors';

export interface MoneyProps {
    amount: string;
    currency: string
}

const currencies = new Set(Intl.supportedValuesOf('currency'));
const MAX_CENTS = 10n ** 30n - 1n; // NUMERIC: até 28 dígitos inteiros + 2 decimais.

/** Centavos inteiros exatos. Nenhuma conversão monetária para number. */
export class Money {
    private constructor(private readonly cents: bigint, public readonly currency: string) {
        if (cents > MAX_CENTS || cents < -MAX_CENTS) throw new DomainError('INVALID_MONEY');
        Object.freeze(this);
    }

    /** Contrato de entrada: proíbe valores negativos e rejeita arredondamento implícito. */
    static from(props: MoneyProps): Money {
        return Money.parse(props, false);
    }

    /** Reconstrução exata; aceita sinais para diferenças e movimentos internos. */
    static rehydrate(props: MoneyProps): Money {
        return Money.parse(props, true);
    }

    static zero(currency: string): Money {
        return Money.from({amount: '0.00', currency});
    }

    private static parse(props: MoneyProps, signed: boolean): Money {
        if (!props || typeof props.amount !== 'string' || props.amount.length > 32
            || typeof props.currency !== 'string' || !currencies.has(props.currency)
            || !(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(props.amount)) {
            throw new DomainError('INVALID_MONEY');
        }
        const negative = props.amount.startsWith('-');
        const [whole, fraction = ''] = props.amount.replace(/^-/, '').split('.');
        const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
        return new Money(negative ? -cents : cents, props.currency);
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.cents + other.cents, this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.cents - other.cents, this.currency);
    }

    negate(): Money {
        return new Money(-this.cents, this.currency);
    }

    isZero(): boolean {
        return this.cents === 0n;
    }

    isPositive(): boolean {
        return this.cents > 0n;
    }

    isNegative(): boolean {
        return this.cents < 0n;
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.cents < other.cents;
    }

    equals(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.cents === other.cents;
    }

    toString(): string {
        const absolute = this.cents < 0n ? -this.cents : this.cents;
        return `${this.cents < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
    }

    toJSON(): MoneyProps {
        return {amount: this.toString(), currency: this.currency};
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
    }
}
