/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Statement } = require("./Statement");

class IfStatement extends Statement {
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {Statement} */
    statement = null;
    /** @type {Statement} */
    elseStatement = null;
}

exports.IfStatement = IfStatement;
