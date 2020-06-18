/**
 * @typedef {import('../../tokenizer').Token} Token
 * @typedef {import('java-mti').CEIType} CEIType
 */
const { LiteralValue } = require('./LiteralValue');

class StringLiteral extends LiteralValue {
    /**
     * 
     * @param {Token} token 
     * @param {CEIType} string_type
     */
    constructor(token, string_type) {
        super(token, string_type);
    }
}

exports.StringLiteral = StringLiteral;
