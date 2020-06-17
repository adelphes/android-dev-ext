/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");

class IncDecExpression extends Expression {
    /**
     * @param {ResolvedIdent} expr
     * @param {Token} operator
     * @param {'prefix'|'postfix'} which
     */
    constructor(expr, operator, which) {
        super();
        this.expr = expr;
        this.operator = operator;
        this.which = which;
    }

    tokens() {
        return this.operator;
    }
}

exports.IncDecExpression = IncDecExpression;
