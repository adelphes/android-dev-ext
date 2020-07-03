/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../body-types').ResolvedValue} ResolvedValue
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { JavaType, PrimitiveType } = require('java-mti');
const ParseProblem = require('../parsetypes/parse-problem');
const { AnyType, MultiValueType, TypeIdentType } = require('../anys');
const { NumberLiteral } = require('./literals/Number');
const { checkTypeAssignable } = require('../expression-resolver');

class BinaryOpExpression extends Expression {
    /**
     * @param {ResolvedIdent} lhs
     * @param {Token} op
     * @param {ResolvedIdent} rhs
     */
    constructor(lhs, op, rhs) {
        super();
        this.lhs = lhs;
        this.op = op;
        this.rhs = rhs;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const operator = this.op.value;
        const lhsvalue = this.lhs.resolveExpression(ri);
        const rhsvalue = this.rhs.resolveExpression(ri);

        if (lhsvalue instanceof AnyType || rhsvalue instanceof AnyType) {
            return AnyType.Instance;
        }

        if (lhsvalue instanceof NumberLiteral || rhsvalue instanceof NumberLiteral) {
            if (lhsvalue instanceof NumberLiteral && rhsvalue instanceof NumberLiteral) {
                // if they are both literals, compute the result
                if (/^[*/%+-]$/.test(operator)) {
                    return NumberLiteral[operator](lhsvalue, rhsvalue);
                }
                if (/^([&|^]|<<|>>>?)$/.test(operator) && !/[FD]/.test(`${lhsvalue.type.typeSignature}${rhsvalue.type.typeSignature}`)) {
                    return NumberLiteral[operator](lhsvalue, rhsvalue);
                }
            }
        }

        if (operator === 'instanceof') {
            if (!(rhsvalue instanceof TypeIdentType)) {
                ri.problems.push(ParseProblem.Error(this.rhs.tokens, `Type expected`));
            }
            if (!(lhsvalue instanceof JavaType || lhsvalue instanceof NumberLiteral)) {
                ri.problems.push(ParseProblem.Error(this.lhs.tokens, `Expression expected`));
            }
            return PrimitiveType.map.Z;
        }

        if (/^([*/%&|^+-]?=|<<=|>>>?=)$/.test(operator)) {
            let src_type = rhsvalue;
            if (operator.length > 1) {
                const result_types = checkOperator(operator.slice(0,-1), ri, this.op, lhsvalue, rhsvalue);
                src_type = Array.isArray(result_types) ? new MultiValueType(...result_types) : result_types;
            }
            if (lhsvalue instanceof JavaType) {
                checkTypeAssignable(lhsvalue, src_type, () => this.rhs.tokens, ri.problems);
                // result of assignments are lhs type
                return lhsvalue;
            }
            ri.problems.push(ParseProblem.Error(this.op, `Invalid assignment`));
            return AnyType.Instance;
        }

        const result_types = checkOperator(operator, ri, this.op, lhsvalue, rhsvalue);
        return Array.isArray(result_types) ? new MultiValueType(...result_types) : result_types;
    }

    tokens() {
        return [...this.lhs.tokens, this.op, ...this.rhs.tokens];
    }
}

/**
 * 
 * @param {string} operator 
 * @param {ResolveInfo} ri 
 * @param {Token} operator_token 
 * @param {ResolvedValue} lhstype 
 * @param {ResolvedValue} rhstype 
 * @returns {JavaType|JavaType[]}
 */
function checkOperator(operator, ri, operator_token, lhstype, rhstype) {

    if (lhstype instanceof MultiValueType) {
        /** @type {JavaType[]} */
        let types = [];
        lhstype.types.reduce((arr, type) => {
            const types = checkOperator(operator, ri, operator_token, type, rhstype);
            Array.isArray(types) ? arr.splice(arr.length, 0, ...types) : arr.push(types);
            return arr;
        }, types);
        types = [...new Set(types)];
        return types.length === 1 ? types[0] : types;
    }

    if (rhstype instanceof MultiValueType) {
        /** @type {JavaType[]} */
        let types = [];
        rhstype.types.reduce((arr, type) => {
            const types = checkOperator(operator, ri, operator_token, lhstype, type);
            Array.isArray(types) ? arr.splice(arr.length, 0, ...types) : arr.push(types);
            return arr;
        }, types);
        types = [...new Set(types)];
        return types.length === 1 ? types[0] : types;
    }

    if (lhstype instanceof NumberLiteral) {
        lhstype = lhstype.type;
    }
    if (rhstype instanceof NumberLiteral) {
        rhstype = rhstype.type;
    }

    if (!(lhstype instanceof JavaType)) {
        return AnyType.Instance;
    }
    if (!(rhstype instanceof JavaType)) {
        return AnyType.Instance;
    }

    const typekey = `${lhstype.typeSignature}#${rhstype.typeSignature}`;

    if (operator === '+' && /(^|#)Ljava\/lang\/String;/.test(typekey)) {
        // string appending is compatible with all types
        return ri.typemap.get('java/lang/String');
    }

    if (/^[*/%+-]$/.test(operator)) {
        // math operators - must be numeric
        if (!/^[BSIJFDC]#[BSIJFDC]$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        if (/^(D|F#[^D]|J#[^FD]|I#[^JFD])/.test(typekey)) {
            return lhstype;
        }
        if (/^(.#D|.#F|.#J|.#I)/.test(typekey)) {
            return rhstype;
        }
        return PrimitiveType.map.I;
    }

    if (/^(<<|>>>?)$/.test(operator)) {
        // shift operators - must be integral
        if (!/^[BSIJC]#[BSIJC]$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        if (/^J/.test(typekey)) {
            return PrimitiveType.map.J;
        }
        return PrimitiveType.map.I;
    }

    if (/^[&|^]$/.test(operator)) {
        // bitwise or logical operators
        if (!/^[BSIJC]#[BSIJC]$|^Z#Z$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        if (/^[JZ]/.test(typekey)) {
            return lhstype;
        }
        return PrimitiveType.map.I;
    }

    if (/^(&&|\|\|)$/.test(operator)) {
        // logical operators
        if (!/^Z#Z$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        return PrimitiveType.map.Z;
    }

    if (/^(>=?|<=?)$/.test(operator)) {
        // numeric comparison operators
        if (!/^[BSIJFDC]#[BSIJFDC]$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        return PrimitiveType.map.Z;
    }

    // comparison operators
    if (typekey === 'Ljava/lang/String;#Ljava/lang/String;') {
        ri.problems.push(ParseProblem.Warning(operator_token, `Using equality operators '=='/'!=' to compare strings has unpredictable behaviour. Consider using String.equals(...) instead.`));
    }
    return PrimitiveType.map.Z;
}

exports.BinaryOpExpression = BinaryOpExpression;
