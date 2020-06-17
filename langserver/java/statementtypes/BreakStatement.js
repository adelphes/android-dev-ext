/**
 * @typedef {import('../tokenizer').Token} Token
 */
const { Statement } = require("./Statement");

class BreakStatement extends Statement {
    /** @type {Token} */
    target = null;
}

exports.BreakStatement = BreakStatement;
