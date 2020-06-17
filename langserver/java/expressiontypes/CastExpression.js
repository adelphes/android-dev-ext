/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Expression } = require("./Expression");

class CastExpression extends Expression {
    /**
     * @param {ResolvedIdent} castType
     * @param {ResolvedIdent} expression
     */
    constructor(castType, expression) {
        super();
        this.castType = castType;
        this.expression = expression;
    }
}

exports.CastExpression = CastExpression;
