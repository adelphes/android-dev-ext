/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 */
const { Expression } = require("./Expression");
const { Block } = require('../statementtypes/Block');
const { LambdaType } = require('../anys');

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

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        return new LambdaType();
    }

    tokens() {
        if (this.body instanceof Block) {
            return this.body.open; 
        }
        return this.body.tokens;
    }
}
exports.LambdaExpression = LambdaExpression;
