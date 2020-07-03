/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
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

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        return this.expression.resolveExpression(ri);
    }

    tokens() {
        return this.expression.tokens;
    }
}

exports.BracketedExpression = BracketedExpression;
