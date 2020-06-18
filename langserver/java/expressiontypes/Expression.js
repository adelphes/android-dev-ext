/**
 * @typedef {import('java-mti').JavaType} JavaType
 * @typedef {import('java-mti').CEIType} CEIType
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../anys').ResolvedType} ResolvedType
  */

class Expression {

    /**
     * @param {ResolveInfo} ri 
     * @returns {ResolvedType}
     */
    resolveExpression(ri) {
        throw new Error('Expression.resolveType');
    }

    /** @returns {Token|Token[]} */
    tokens() {
        throw new Error('Expression.tokens');
    }
}

exports.Expression = Expression;
