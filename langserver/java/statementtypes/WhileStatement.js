/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('./Block').Block} Block
 */
const { Statement } = require("./Statement");

class WhileStatement extends Statement {
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {Statement} */
    statement = null;
}

exports.WhileStatement = WhileStatement;
