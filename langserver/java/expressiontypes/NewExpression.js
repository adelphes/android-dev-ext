/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../source-types').SourceTypeIdent} SourceTypeIdent
 * @typedef {import('java-mti').JavaType} JavaType
 */
const { Expression } = require("./Expression");
const { ArrayType } = require('java-mti');
const { FixedLengthArrayType, SourceArrayType } = require('../source-types');
const ParseProblem = require('../parsetypes/parse-problem');
const { checkArrayIndex } = require('../expression-resolver');

class NewArray extends Expression {
    /**
     * @param {Token} new_token
     * @param {SourceTypeIdent} element_type
     * @param {ResolvedIdent} dimensions
     */
    constructor(new_token, element_type, dimensions) {
        super();
        this.new_token = new_token;
        this.element_type = element_type;
        this.dimensions = dimensions;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        /** @type {ResolvedIdent[]} */
        const fixed_dimensions = [];
        const type = this.dimensions.types[0];
        for (let x = type; ;) {
            if (x instanceof FixedLengthArrayType) {
                fixed_dimensions.unshift(x.length);
                x = x.parent_type;
                continue;
            }
            if (x instanceof SourceArrayType) {
                x = x.parent_type;
                continue;
            }
            break;
        }
        const arrdims = type instanceof ArrayType ? type.arrdims : 1;
        const array_type = new ArrayType(this.element_type.resolved, arrdims);

        fixed_dimensions.forEach(d => {
            checkArrayIndex(ri, d, 'dimension');
        })
        return array_type;
    }

    tokens() {
        return [this.new_token, ...this.dimensions.tokens];
    }
}

class NewObject extends Expression {
    /**
     * @param {Token} new_token
     * @param {SourceTypeIdent} object_type
     * @param {ResolvedIdent[]} ctr_args
     * @param {Token[]} type_body
     */
    constructor(new_token, object_type, ctr_args, type_body) {
        super();
        this.new_token = new_token;
        this.object_type = object_type;
        this.ctr_args = ctr_args;
        this.type_body = type_body;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        return this.object_type.resolved;
    }

    tokens() {
        return [this.new_token, ...this.object_type.tokens];
    }
}

exports.NewArray = NewArray;
exports.NewObject = NewObject;
