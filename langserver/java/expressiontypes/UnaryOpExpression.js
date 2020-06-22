/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { JavaType, PrimitiveType } = require('java-mti');
const ParseProblem = require('../parsetypes/parse-problem');
const { AnyType } = require('../anys');
const { NumberLiteral } = require('./literals/Number');

class UnaryOpExpression extends Expression {
    /**
     * @param {ResolvedIdent} expression
     * @param {Token} op
     */
    constructor(expression, op) {
        super();
        this.expression = expression;
        this.op = op;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const operator = this.op.value;
        const value = this.expression.resolveExpression(ri);

        if (value instanceof AnyType) {
            return AnyType.Instance;
        }

        if (value instanceof NumberLiteral) {
            if (/^[+-]$/.test(operator)) {
                return NumberLiteral[operator](value);
            }
            if (/^[!~]$/.test(operator) && value.type.typeSignature === 'I') {
                return NumberLiteral[operator](value);
            }
        }

        const type = value instanceof JavaType ? value : value instanceof NumberLiteral ? value.type : null;

        if (!type) {
            ri.problems.push(ParseProblem.Error(this.expression.tokens, `Expression expected`));
            return AnyType.Instance;
        }

        return checkOperator(operator, ri, this.op, type);
    }

    tokens() {
        return [this.op, ...this.expression.tokens];
    }
}

/**
 * 
 * @param {string} operator 
 * @param {ResolveInfo} ri 
 * @param {Token} operator_token 
 * @param {JavaType} type 
 */
function checkOperator(operator, ri, operator_token, type) {

    let is_valid = false;
    /** @type {JavaType} */
    let return_type = AnyType.Instance;

    if (/^[+-]$/.test(operator)) {
        // math operators - must be numeric
        is_valid = /^[BSIJFDC]$/.test(type.typeSignature);
        return_type = type;
    }

    if (/^~$/.test(operator)) {
        // bitwise invert operator - must be integral
        is_valid = /^[BSIJC]$/.test(type.typeSignature);
        return_type = PrimitiveType.map.I;
    }

    if (/^!$/.test(operator)) {
        // logical not operator - must be boolean
        is_valid = /^Z$/.test(type.typeSignature);
        return_type = PrimitiveType.map.Z;
    }

    if (!is_valid) {
        ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for type '${type.fullyDottedTypeName}'`));
    }

    return return_type;
}

exports.UnaryOpExpression = UnaryOpExpression;
