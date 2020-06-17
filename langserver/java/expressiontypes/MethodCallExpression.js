/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Expression } = require("./Expression");

class MethodCallExpression extends Expression {
    /**
     * @param {ResolvedIdent} instance
     * @param {ResolvedIdent[]} args
     */
    constructor(instance, args) {
        super();
        this.instance = instance;
        this.args = args;
    }
}

exports.MethodCallExpression = MethodCallExpression;
