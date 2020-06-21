/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { Statement } = require("./Statement");
const ParseProblem = require('../parsetypes/parse-problem');
const { isTypeAssignable } = require('../expression-resolver');
const { JavaType, PrimitiveType } = require('java-mti');

class AssertStatement extends Statement {
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
            if (!(msg_value instanceof JavaType) || !isTypeAssignable(vi.typemap.get('java/lang/String'), msg_value)) {
                vi.problems.push(ParseProblem.Error(this.message.tokens, `String expression expected`));
            }
        }
    }
}

exports.AssertStatement = AssertStatement;
