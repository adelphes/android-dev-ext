/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { AnyType, TypeIdentType } = require('../anys');

class ThisMemberExpression extends Expression {
    /**
     * @param {ResolvedIdent} instance
     * @param {Token} this_token
     */
    constructor(instance, this_token) {
        super();
        this.instance = instance;
        this.thisToken = this_token;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        // instance should be a type identifier
        const typeident = this.instance.resolveExpression(ri);
        if (typeident instanceof TypeIdentType) {
            return typeident.type;
        }
        return AnyType.Instance;
    }

    tokens() {
        return this.thisToken;
    }
}

exports.ThisMemberExpression = ThisMemberExpression;
