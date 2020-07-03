/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { ArrayValueType } = require('../anys');

class ArrayValueExpression extends Expression {
    /**
     * @param {ResolvedIdent[]} elements 
     * @param {Token} open 
     */
    constructor(elements, open) {
        super();
        this.elements = elements;
        this.open = open;
    }

    tokens() {
        return this.open;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        return new ArrayValueType(this.elements.map(e => ({
            tokens: e.tokens,
            value: e.resolveExpression(ri),
        })));
    }
}

exports.ArrayValueExpression  = ArrayValueExpression;
