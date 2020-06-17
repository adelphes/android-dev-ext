/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Statement } = require("./Statement");

class SynchronizedStatement extends Statement {
    /** @type {ResolvedIdent} */
    expression = null;
    /** @type {Statement} */
    statement = null;
}

exports.SynchronizedStatement = SynchronizedStatement;
