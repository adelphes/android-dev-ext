/**
 * @typedef {import('../../tokenizer').Token} Token
 */
const { LiteralValue } = require('./LiteralValue');
const { PrimitiveType } = require('java-mti');

class BooleanLiteral extends LiteralValue {
    /**
     * 
     * @param {Token} token 
     */
    constructor(token) {
        super(token);
        this.type = PrimitiveType.map.Z;
    }
}

exports.BooleanLiteral = BooleanLiteral;
