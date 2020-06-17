/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Statement } = require("./Statement");

class ThrowStatement extends Statement {
    /** @type {ResolvedIdent} */
    expression = null;
}

exports.ThrowStatement = ThrowStatement;
