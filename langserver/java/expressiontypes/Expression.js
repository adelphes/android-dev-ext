/**
 * @typedef {import('../tokenizer').Token} Token
 */

class Expression {
    /** @returns {Token|Token[]} */
    tokens() {
        throw new Error('Expression.tokens');
    }
}

exports.Expression = Expression;
