/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('./Block').Block} Block
 */
const { Statement } = require("./Statement");

class TryStatement extends Statement {
    /** @type {ResolvedIdent[]} */
    resources = [];
    /** @type {Block} */
    block = null;
    catches = [];
}

exports.TryStatement = TryStatement;
