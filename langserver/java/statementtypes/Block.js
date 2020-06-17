/**
 * @typedef {import('../tokenizer').Token} Token
 */
const { Statement } = require("./Statement");

class Block extends Statement {
    /** @type {Statement[]} */
    statements = [];

    /**
     * @param {Token} open 
     */
    constructor(open) {
        super();
        this.open = open;
    }
}

exports.Block = Block;
