/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");

class ClassMemberExpression extends Expression {
    /**
     * @param {ResolvedIdent} instance
     * @param {Token} class_token
     */
    constructor(instance, class_token) {
        super();
        this.instance = instance;
        this.classToken = class_token;
    }
}
exports.ClassMemberExpression = ClassMemberExpression;
