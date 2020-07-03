/**
 * @typedef {import('java-mti').JavaType} JavaType
 * @typedef {import('../../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../../tokenizer').Token} Token
 * @typedef {import('../../anys').ResolvedValue} ResolvedValue
 */
const { Expression } = require('../Expression');

class LiteralValue extends Expression {
    /**
     * @param {Token|Token[]} tokens 
     * @param {JavaType} known_type
     */
    constructor(tokens, known_type) {
        super();
        this._tokens = tokens;
        this.type = known_type;
    }

    /**
     * @param {ResolveInfo} ri 
     * @returns {ResolvedValue}
     */
    resolveExpression(ri) {
        return this.type;
    }

    tokens() {
        return this._tokens;
    }
}

exports.LiteralValue = LiteralValue;
