/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");

class LambdaExpression extends Expression {
    /**
     *
     * @param {*[]} params
     * @param {Expression|Block} body
     */
    constructor(params, body) {
        super();
        this.params = params;
        this.body = body;
    }
}
exports.LambdaExpression = LambdaExpression;
