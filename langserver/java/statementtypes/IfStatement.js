/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { Statement } = require("./Statement");
const { checkBooleanBranchCondition } = require('../expression-resolver');
const { checkNonVarDeclStatement } = require('../statement-validater');

class IfStatement extends Statement {
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {Statement} */
    statement = null;
    /** @type {Statement} */
    elseStatement = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        const value = this.test.resolveExpression(vi);
        checkBooleanBranchCondition(value, () => this.test.tokens, vi.problems);

        if (this.statement) {
            vi.statementStack.unshift('if');
            checkNonVarDeclStatement(this.statement, vi);
            vi.statementStack.shift();
        }
        if (this.elseStatement) {
            vi.statementStack.unshift('else');
            checkNonVarDeclStatement(this.statement, vi);
            vi.statementStack.shift();
        }
    }
}

exports.IfStatement = IfStatement;
