/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Statement } = require("./Statement");

class ReturnStatement extends Statement {
    /** @type {ResolvedIdent} */
    expression = null;
}

exports.ReturnStatement = ReturnStatement;
