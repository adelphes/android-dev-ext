/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Expression } = require("./Expression");

class ArrayValueExpression extends Expression {
    /**
     * @param {ResolvedIdent[]} elements 
     */
    constructor(elements) {
        super();
        this.elements = elements;
    }
}

exports.ArrayValueExpression  = ArrayValueExpression;
