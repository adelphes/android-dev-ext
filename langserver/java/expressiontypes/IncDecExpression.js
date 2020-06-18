/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { PrimitiveType } = require('java-mti');
const { AnyType } = require('../anys');

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

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const type = this.expr.resolveExpression(ri);
        if (type instanceof PrimitiveType) {
            if (/^[BSIJFD]$/.test(type.typeSignature)) {
                return type;
            }
        }
        return AnyType.Instance;
    }

    tokens() {
        return this.operator;
    }
}

exports.IncDecExpression = IncDecExpression;
