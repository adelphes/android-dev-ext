/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");

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
}

exports.ThisMemberExpression = ThisMemberExpression;
