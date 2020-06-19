/**
 * @typedef {import('java-mti').JavaType} JavaType
 * @typedef {import('java-mti').CEIType} CEIType
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../anys').ResolvedValue} ResolvedValue
  */

class Expression {

    /**
     * @param {ResolveInfo} ri 
     * @returns {ResolvedValue}
     */
    resolveExpression(ri) {
        throw new Error('Expression.resolveExpression');
    }

    /** @returns {Token|Token[]} */
    tokens() {
        throw new Error('Expression.tokens');
    }
}

exports.Expression = Expression;
