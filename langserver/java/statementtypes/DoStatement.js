/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('./Block').Block} Block
 */
const { Statement } = require("./Statement");

class DoStatement extends Statement {
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {Block} */
    block = null;
}

exports.DoStatement = DoStatement;
