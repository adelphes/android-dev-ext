/**
 * @typedef {import('./Statement').Statement} Statement
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { KeywordStatement } = require("./KeywordStatement");
const { checkBooleanBranchCondition } = require('../expression-resolver');
const { checkNonVarDeclStatement } = require('../statement-validater');

class IfStatement extends KeywordStatement {
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
        if (this.test) {
            const value = this.test.resolveExpression(vi);
            checkBooleanBranchCondition(value, () => this.test.tokens, vi.problems);
        }
        if (this.statement) {
            vi.statementStack.unshift('if');
            checkNonVarDeclStatement(this.statement, vi);
            vi.statementStack.shift();
        }
        if (this.elseStatement) {
            vi.statementStack.unshift('else');
            checkNonVarDeclStatement(this.elseStatement, vi);
            vi.statementStack.shift();
        }
    }
}

exports.IfStatement = IfStatement;
