/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../body-types').ResolvedValue} ResolvedValue
 * @typedef {import('../source-types').SourceMethodLike} SourceMethodLike
 * @typedef {import('../tokenizer').Token} Token
 */
const { JavaType, PrimitiveType } = require('java-mti');
const { KeywordStatement } = require("./KeywordStatement");
const ParseProblem = require('../parsetypes/parse-problem');
const { isTypeAssignable } = require('../expression-resolver');
const { NumberLiteral } = require('../expressiontypes/literals/Number');
const { LambdaType, MultiValueType } = require('../anys');

class ReturnStatement extends KeywordStatement {
    /** @type {ResolvedIdent} */
    expression = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        const method_return_type = vi.method.returnType;
        if (!this.expression) {
            if (method_return_type !== PrimitiveType.map.V) {
                vi.problems.push(ParseProblem.Error(this.keyword, `Method must return a value of type '${method_return_type.fullyDottedTypeName}'`));
            }
            return;
        }
        if (method_return_type === PrimitiveType.map.V) {
            vi.problems.push(ParseProblem.Error(this.expression.tokens, `void method cannot return a value`));
            return;
        }
        const type = this.expression.resolveExpression(vi);
        checkType(type, () => this.expression.tokens);

        /**
         * @param {ResolvedValue} type 
         * @param {() => Token[]} tokens 
         */
        function checkType(type, tokens) {
            if (type instanceof JavaType || type instanceof NumberLiteral) {
                if (!isTypeAssignable(method_return_type, type)) {
                    const expr_type = type instanceof NumberLiteral ? type.type : type;
                    vi.problems.push(ParseProblem.Error(tokens(), `Incompatible types: expression of type '${expr_type.fullyDottedTypeName}' cannot be returned from a method of type '${method_return_type.fullyDottedTypeName}'`));
                }
            } else if (type instanceof MultiValueType) {
                // ternary, eg. return x > 0 ? 1 : 2;
                type.types.forEach(type => checkType(type, tokens));
            } else if (type instanceof LambdaType) {
                if (!isTypeAssignable(method_return_type, type)) {
                    vi.problems.push(ParseProblem.Error(tokens(), `Incompatible types: lambda expression is not compatible with method type '${method_return_type.fullyDottedTypeName}'`));
                }
            } else {
                vi.problems.push(ParseProblem.Error(tokens(), `'${method_return_type.fullyDottedTypeName}' type expression expected`));
            }
        }
    }
}

exports.ReturnStatement = ReturnStatement;
