/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../statementtypes/Block').Block} Block
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
