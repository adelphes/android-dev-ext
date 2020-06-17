/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Expression } = require("./Expression");

class ArrayIndexExpression extends Expression {
    /**
     * @param {ResolvedIdent} instance
     * @param {ResolvedIdent} index
     */
    constructor(instance, index) {
        super();
        this.instance = instance;
        this.index = index;
    }

    tokens() {
        return [...this.instance.tokens, ...this.index.tokens];
    }
}

exports.ArrayIndexExpression = ArrayIndexExpression;
