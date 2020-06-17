/**
 * @typedef {import('../tokenizer').Token} Token
 */
const { Statement } = require("./Statement");

class InvalidStatement extends Statement {
    /**
     * 
     * @param {Token} token 
     */
    constructor(token) {
        super();
        this.token = token;
    }
}

exports.InvalidStatement = InvalidStatement;
