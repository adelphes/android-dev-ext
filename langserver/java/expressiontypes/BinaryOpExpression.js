/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");

class BinaryOpExpression extends Expression {
    /**
     * @param {ResolvedIdent} lhs
     * @param {Token} op
     * @param {ResolvedIdent} rhs
     */
    constructor(lhs, op, rhs) {
        super();
        this.lhs = lhs;
        this.op = op;
        this.rhs = rhs;
    }

    tokens() {
        return [...this.lhs.tokens, this.op, ...this.rhs.tokens];
    }
}

exports.BinaryOpExpression = BinaryOpExpression;
