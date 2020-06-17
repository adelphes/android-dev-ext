/**
 * @typedef {import('../tokenizer').Token} Token
 */
const { Statement } = require("./Statement");

class ContinueStatement extends Statement {
    /** @type {Token} */
    target = null;
}

exports.ContinueStatement = ContinueStatement;
