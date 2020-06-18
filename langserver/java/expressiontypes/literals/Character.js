/**
 * @typedef {import('../../tokenizer').Token} Token
 */
const { LiteralValue } = require('./LiteralValue');
const { PrimitiveType } = require('java-mti');

class CharacterLiteral extends LiteralValue {
    /**
     * 
     * @param {Token} token 
     */
    constructor(token) {
        super(token, PrimitiveType.map.C);
    }
}

exports.CharacterLiteral = CharacterLiteral;
