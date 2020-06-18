/**
 * @typedef {import('java-mti').JavaType} JavaType
 * @typedef {import('../../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../../tokenizer').Token} Token
 */
const { Expression } = require('../Expression');

class LiteralValue extends Expression {
    /**
     * @param {Token} token 
     * @param {JavaType} known_type
     */
    constructor(token, known_type) {
        super();
        this.token = token;
        this.type = known_type;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        return this.type;
    }

    tokens() {
        return this.token;
    }
}

exports.LiteralValue = LiteralValue;
