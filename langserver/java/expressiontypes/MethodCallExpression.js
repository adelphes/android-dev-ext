/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 */
const { Expression } = require("./Expression");
const { AnyType, MethodType } = require('../anys');

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

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const type = this.instance.resolveExpression(ri);
        if (!(type instanceof MethodType)) {
            return AnyType.Instance;
        }
        const arg_types = this.args.map(arg => arg.resolveExpression(ri));
        return type.methods[0].returnType;
    }

    tokens() {
        return this.instance.tokens;
    }
}

exports.MethodCallExpression = MethodCallExpression;
