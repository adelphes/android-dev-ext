/**
 * @typedef {import('../../tokenizer').Token} Token
 */
const { LiteralValue } = require('./LiteralValue');
const { NullType } = require('java-mti');

class NullLiteral extends LiteralValue {
    /**
     * 
     * @param {Token} token 
     */
    constructor(token) {
        super(token);
        this.type = new NullType();
    }
}

exports.NullLiteral = NullLiteral;
