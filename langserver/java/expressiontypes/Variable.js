/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').Local} Local
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('java-mti').Field} Field
 * @typedef {import('java-mti').Parameter} Parameter
 * @typedef {import('../source-types').SourceEnumValue} SourceEnumValue
 */
const { Expression } = require("./Expression");

class Variable extends Expression {
    /**
     * @param {Token} name_token
     * @param {Local|Parameter|Field|SourceEnumValue} variable
     */
    constructor(name_token, variable) {
        super();
        this.name_token = name_token;
        this.variable = variable;
        this.type = this.variable.type;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveType(ri) {
        return this.type;
    }

    tokens() {
        return this.name_token;
    }
}

exports.Variable = Variable;
