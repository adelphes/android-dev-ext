/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('./Block').Block} Block
 * @typedef {import('../body-types').Local} Local
 */
const { Statement } = require("./Statement");

class TryStatement extends Statement {
    /** @type {(ResolvedIdent|Local[])[]} */
    resources = [];
    /** @type {Block} */
    block = null;
    catches = [];
}

exports.TryStatement = TryStatement;
