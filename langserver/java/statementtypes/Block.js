const { Statement } = require("./Statement");

class Block extends Statement {
    /** @type {Statement[]} */
    statements = [];
}

exports.Block = Block;
