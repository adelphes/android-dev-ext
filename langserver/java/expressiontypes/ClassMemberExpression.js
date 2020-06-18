/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 */
const { Expression } = require("./Expression");
const { AnyType } = require('../anys');
const ParseProblem = require('../parsetypes/parse-problem');

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

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const classType = ri.typemap.get('java/lang/Class');
        const type = this.instance.types[0];
        if (!type) {
            ri.problems.push(ParseProblem.Error(this.instance.tokens, `Type expected`));
        }
        return classType.specialise([type || AnyType.Instance]);
    }

    tokens() {
        return this.classToken;
    }
}
exports.ClassMemberExpression = ClassMemberExpression;
