/**
 * @typedef {import('./Statement').Statement} Statement
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { KeywordStatement } = require("./KeywordStatement");
const { checkBooleanBranchCondition } = require('../expression-resolver');

class WhileStatement extends KeywordStatement {
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {Statement} */
    statement = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        const value = this.test.resolveExpression(vi);
        checkBooleanBranchCondition(value, () => this.test.tokens, vi.problems);

        if (this.statement) {
            vi.statementStack.unshift('while');
            this.statement.validate(vi);
            vi.statementStack.shift();
        }
    }
}

exports.WhileStatement = WhileStatement;
