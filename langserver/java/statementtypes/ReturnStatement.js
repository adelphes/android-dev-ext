/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { JavaType, PrimitiveType } = require('java-mti');
const { Statement } = require("./Statement");
const ParseProblem = require('../parsetypes/parse-problem');
const { isTypeAssignable } = require('../expression-resolver');
const { NumberLiteral } = require('../expressiontypes/literals/Number');
const { MultiValueType } = require('../anys');

class ReturnStatement extends Statement {
    /** @type {ResolvedIdent} */
    expression = null;

    /**
     * @param {Token} return_token 
     */
    constructor(return_token) {
        super();
        this.return_token = return_token;
    }

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        const method_return_type = vi.method.returnType;
        if (!this.expression) {
            if (method_return_type !== PrimitiveType.map.V) {
                vi.problems.push(ParseProblem.Error(this.return_token, `Method must return a value of type '${method_return_type.fullyDottedTypeName}'`));
            }
            return;
        }
        if (method_return_type === PrimitiveType.map.V) {
            vi.problems.push(ParseProblem.Error(this.expression.tokens, `void method cannot return a value`));
            return;
        }
        const type = this.expression.resolveExpression(vi);
        checkType(type);

        function checkType(type) {
            if (type instanceof JavaType || type instanceof NumberLiteral) {
                if (!isTypeAssignable(method_return_type, type)) {
                    const expr_type = type instanceof NumberLiteral ? type.type : type;
                    vi.problems.push(ParseProblem.Error(this.expression.tokens, `Incompatible types: expression of type '${expr_type.fullyDottedTypeName}' cannot be returned from a method of type '${method_return_type.fullyDottedTypeName}'`));
                }
            } else if (type instanceof MultiValueType) {
                // ternary, eg. return x > 0 ? 1 : 2;
                type.types.forEach(type => checkType(type));
            } else {
                vi.problems.push(ParseProblem.Error(this.expression.tokens, `'${method_return_type.fullyDottedTypeName}' type expression expected`));
            }
        }
    }
}

exports.ReturnStatement = ReturnStatement;
