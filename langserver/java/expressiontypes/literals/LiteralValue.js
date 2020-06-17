/**
 * @typedef {import('../../tokenizer').Token} Token
 */
const { Expression } = require('../Expression');

class LiteralValue extends Expression {
    /**
     * @param {Token} token 
     */
    constructor(token) {
        super();
        this.token = token;
    }

    tokens() {
        return this.token;
    }
}

exports.LiteralValue = LiteralValue;
