/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Expression } = require("./Expression");

class BracketedExpression extends Expression {
    /**
     * @param {ResolvedIdent} expression
     */
    constructor(expression) {
        super();
        this.expression = expression;
    }
}

exports.BracketedExpression = BracketedExpression;
