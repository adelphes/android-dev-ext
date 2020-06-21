/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { JavaType, PrimitiveType } = require('java-mti');
const ParseProblem = require('../parsetypes/parse-problem');
const { AnyType, TypeIdentType } = require('../anys');
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

        const lhstype = lhsvalue instanceof JavaType ? lhsvalue : lhsvalue instanceof NumberLiteral ? lhsvalue.type : null;
        const rhstype = rhsvalue instanceof JavaType ? rhsvalue : rhsvalue instanceof NumberLiteral ? rhsvalue.type : null;

        if (operator === 'instanceof') {
            if (!(rhsvalue instanceof TypeIdentType)) {
                ri.problems.push(ParseProblem.Error(this.rhs.tokens, `Type expected`));
            }
            if (!lhstype) {
                ri.problems.push(ParseProblem.Error(this.rhs.tokens, `Expression expected`));
            }
            return PrimitiveType.map.Z;
        }

        if (!lhstype || !rhstype) {
            if (!lhstype) {
                ri.problems.push(ParseProblem.Error(this.lhs.tokens, `Expression expected`));
            }
            if (!rhstype) {
                ri.problems.push(ParseProblem.Error(this.rhs.tokens, `Expression expected`));
            }
            return AnyType.Instance;
        }

        const typekey = `${lhstype.typeSignature}#${rhstype.typeSignature}`;

        if (operator === '+' && /(^|#)Ljava\/lang\/String;/.test(typekey)) {
            // string appending is compatible with all types
            return ri.typemap.get('java/lang/String');
        }

        if (/^([*/%&|^+-]?=|<<=|>>>?=)$/.test(operator)) {
            let src_type = rhsvalue;
            if (operator.length > 1) {
                src_type = checkOperator(operator.slice(0,-1), ri, this.op, typekey, lhstype, rhstype);
            }
            checkTypeAssignable(lhstype, src_type, () => this.rhs.tokens, ri.problems);
            // result of assignments are lhs
            return lhstype;
        }

        return checkOperator(operator, ri, this.op, typekey, lhstype, rhstype);
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
 * @param {string} typekey 
 * @param {JavaType} lhstype 
 * @param {JavaType} rhstype 
 */
function checkOperator(operator, ri, operator_token, typekey, lhstype, rhstype) {

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
