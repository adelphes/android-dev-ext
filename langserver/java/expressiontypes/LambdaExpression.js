/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 */
const { Expression } = require("./Expression");
const { Block } = require('../statementtypes/Block');
const { AnyType, LambdaType } = require('../anys');
const { Local } = require('../body-types');

class LambdaExpression extends Expression {
    /**
     *
     * @param {(Local|ResolvedIdent)[]} params
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
        let return_type;
        if (this.body instanceof Block) {
            // todo - search for return statements to work out what return value the lambda has
            return_type = AnyType.Instance;
        } else {
            return_type = this.body.resolveExpression(ri);
        }
        const param_types = this.params.map(p => {
            if (p instanceof Local) {
                return p.type;
            }
            return AnyType.Instance;
        })
        return new LambdaType(param_types, return_type);

    }

    tokens() {
        if (this.body instanceof Block) {
            return this.body.open; 
        }
        return this.body.tokens;
    }
}
exports.LambdaExpression = LambdaExpression;
