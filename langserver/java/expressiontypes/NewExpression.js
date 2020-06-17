/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('java-mti').JavaType} JavaType
 */
const { Expression } = require("./Expression");

class NewArray extends Expression {
    /**
     * @param {JavaType} element_type
     * @param {ResolvedIdent} dimensions
     */
    constructor(element_type, dimensions) {
        super();
        this.element_type = element_type;
        this.dimensions = dimensions;
    }
}

class NewObject extends Expression {
    /**
     * @param {JavaType} object_type
     * @param {ResolvedIdent[]} ctr_args
     * @param {Token[]} type_body
     */
    constructor(object_type, ctr_args, type_body) {
        super();
        this.element_type = object_type;
        this.ctr_args = ctr_args;
        this.type_body = type_body;
    }
}

exports.NewArray = NewArray;
exports.NewObject = NewObject;
