/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");

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
}

exports.ArrayValueExpression  = ArrayValueExpression;
