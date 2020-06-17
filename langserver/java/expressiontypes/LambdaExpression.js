/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Expression } = require("./Expression");
const { Block } = require('../statementtypes/Block');

class LambdaExpression extends Expression {
    /**
     *
     * @param {*[]} params
     * @param {ResolvedIdent|Block} body
     */
    constructor(params, body) {
        super();
        this.params = params;
        this.body = body;
    }

    tokens() {
        if (this.body instanceof Block) {
            return this.body.open; 
        }
        return this.body.tokens;
    }
}
exports.LambdaExpression = LambdaExpression;
