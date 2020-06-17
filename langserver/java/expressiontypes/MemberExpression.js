/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");

class MemberExpression extends Expression {
    /**
     * @param {ResolvedIdent} instance
     * @param {Token|null} member
     */
    constructor(instance, member) {
        super();
        this.instance = instance;
        // member will be null for incomplete expressions
        this.member = member;
    }

    tokens() {
        return this.member;
    }
}

exports.MemberExpression = MemberExpression;
