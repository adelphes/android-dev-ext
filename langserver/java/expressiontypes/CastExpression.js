/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 */
const { Expression } = require("./Expression");
const { AnyType, TypeIdentType } = require('../anys');

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

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const cast_type = this.castType.resolveExpression(ri);
        if (cast_type instanceof TypeIdentType) {
            return cast_type.type;
        }
        return AnyType.Instance;
    }

    tokens() {
        return [...this.castType.tokens, ...this.expression.tokens];
    }
}

exports.CastExpression = CastExpression;
