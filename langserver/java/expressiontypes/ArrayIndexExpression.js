/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 */
const { Expression } = require("./Expression");
const { ArrayType } = require('java-mti');
const { AnyType } = require('../anys');

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

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const instance_type = this.instance.resolveExpression(ri);
        if (instance_type instanceof ArrayType) {
            return instance_type.elementType;
        }
        return AnyType.Instance;
    }
}

exports.ArrayIndexExpression = ArrayIndexExpression;
