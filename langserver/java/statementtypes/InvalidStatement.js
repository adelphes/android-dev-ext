/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../source-types').SourceMethodLike} SourceMethodLike
 */
const { Statement } = require("./Statement");

class InvalidStatement extends Statement {
    /**
     * @param {SourceMethodLike} owner
     * @param {Token} token 
     */
    constructor(owner, token) {
        super(owner);
        this.token = token;
    }
}

exports.InvalidStatement = InvalidStatement;
