/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { JavaType } = require('java-mti');
const { Statement } = require("./Statement");
const { isTypeAssignable } = require('../expression-resolver');
const ParseProblem = require('../parsetypes/parse-problem');

class ThrowStatement extends Statement {
    /** @type {ResolvedIdent} */
    expression = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (!this.expression) {
            return;
        }
        const throw_value = this.expression.resolveExpression(vi);
        if (throw_value instanceof JavaType) {
            if (!isTypeAssignable(vi.typemap.get('java/lang/Throwable'), throw_value)) {
                vi.problems.push(ParseProblem.Error(this.expression.tokens, `throw expression does not inherit from java.lang.Throwable`));
            }
        } else {
            vi.problems.push(ParseProblem.Error(this.expression.tokens, `Throwable expression expected`));
        }
    }
}

exports.ThrowStatement = ThrowStatement;
