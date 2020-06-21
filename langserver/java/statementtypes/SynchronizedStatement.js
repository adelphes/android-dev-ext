/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { CEIType } = require('java-mti');
const { Statement } = require("./Statement");
const ParseProblem = require('../parsetypes/parse-problem');

class SynchronizedStatement extends Statement {
    /** @type {ResolvedIdent} */
    expression = null;
    /** @type {Statement} */
    statement = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (this.expression) {
            const value = this.expression.resolveExpression(vi);
            // locks must be a reference type
            if (!(value instanceof CEIType)) {
                vi.problems.push(ParseProblem.Error(this.expression.tokens, `Lock expression must be a reference type`));
            }
        }
        if (this.statement) {
            vi.statementStack.unshift('synchronized');
            this.statement.validate(vi);
            vi.statementStack.shift();
        }
    }
}

exports.SynchronizedStatement = SynchronizedStatement;
