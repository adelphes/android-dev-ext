/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { KeywordStatement } = require("./KeywordStatement");
const ParseProblem = require('../parsetypes/parse-problem');
const { isTypeAssignable } = require('../expression-resolver');
const { JavaType, PrimitiveType } = require('java-mti');

class AssertStatement extends KeywordStatement {
    /** @type {ResolvedIdent} */
    expression = null;
    /** @type {ResolvedIdent} */
    message = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (this.expression) {
            const value = this.expression.resolveExpression(vi);
            if (!(value instanceof JavaType) || !isTypeAssignable(PrimitiveType.map.Z, value)) {
                vi.problems.push(ParseProblem.Error(this.expression.tokens, `Boolean expression expected`));
            }
        }

        if (this.message) {
            const msg_value = this.message.resolveExpression(vi);
            if (!(msg_value instanceof JavaType)) {
                vi.problems.push(ParseProblem.Error(this.message.tokens, `Expression expected`));
            } else if (msg_value === PrimitiveType.map.V) {
                vi.problems.push(ParseProblem.Error(this.message.tokens, `Expression type cannot be 'void'`));
            }
        }
    }
}

exports.AssertStatement = AssertStatement;
