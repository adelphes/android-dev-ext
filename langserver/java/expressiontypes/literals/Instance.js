/**
 * @typedef {import('../../tokenizer').Token} Token
 * @typedef {import('java-mti').CEIType} CEIType
 */
const { LiteralValue } = require('./LiteralValue');

class InstanceLiteral extends LiteralValue {
    /**
     * 
     * @param {Token} token 'this' or 'super' token
     * @param {CEIType} scoped_type 
     */
    constructor(token, scoped_type) {
        super(token);
        this.scoped_type = scoped_type;
    }
}

exports.InstanceLiteral = InstanceLiteral;
