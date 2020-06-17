/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Statement } = require("./Statement");

class SwitchStatement extends Statement {
    /** @type {ResolvedIdent} */
    test = null;
    cases = [];
    caseBlocks = [];
}

exports.SwitchStatement = SwitchStatement;
