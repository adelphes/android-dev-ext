/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../expressiontypes/Expression').Expression} Expression
 * @typedef {import('../source-types').SourceMethodLike} SourceMethodLike
 */
const { Statement } = require("./Statement");
const { BinaryOpExpression } = require('../expressiontypes/BinaryOpExpression');
const { MethodCallExpression } = require('../expressiontypes/MethodCallExpression');
const { NewObject } = require('../expressiontypes/NewExpression');
const { IncDecExpression } = require('../expressiontypes/IncDecExpression');
const ParseProblem = require('../parsetypes/parse-problem');

class ExpressionStatement extends Statement {
    /**
     * @param {SourceMethodLike} owner
     * @param {ResolvedIdent} expression 
     */
    constructor(owner, expression) {
        super(owner);
        this.expression = expression;
    }

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        // only method calls, new objects, increments and assignments are allowed as expression statements
        const e = this.expression.variables[0];
        let is_statement = e instanceof MethodCallExpression || e instanceof NewObject || e instanceof IncDecExpression;
        if (e instanceof BinaryOpExpression) {
            is_statement = e.op.kind === 'assignment-operator';
        }
        if (!is_statement) {
            vi.problems.push(ParseProblem.Error(this.expression.tokens, `Statement expected`));
        }
        this.expression.resolveExpression(vi);
    }
}

exports.ExpressionStatement = ExpressionStatement;
