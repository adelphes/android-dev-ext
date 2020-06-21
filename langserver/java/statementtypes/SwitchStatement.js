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

class SwitchStatement extends Statement {
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {(ResolvedIdent|boolean)[]} */
    cases = [];
    /** @type {{cases: (ResolvedIdent|boolean)[], statements: Statement[]} []} */
    caseBlocks = [];

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        let test_type = null;
        if (this.test) {
            test_type = this.test.resolveExpression(vi);
            if (test_type instanceof NumberLiteral) {
                test_type = test_type.type;
            }
            if (test_type instanceof JavaType) {
                if (!isTypeAssignable(vi.typemap.get('java/lang/String'), test_type)) {
                    if (!isTypeAssignable(PrimitiveType.map.I, test_type)) {
                        test_type = null;
                    }
                }
            } else {
                test_type = null;
            }
            if (!test_type) {
                vi.problems.push(ParseProblem.Error(this.test.tokens, `Switch expression must be of type 'int' or 'java.lang.String'`));
            }
        }

        vi.statementStack.unshift('switch');

        this.caseBlocks.forEach(caseblock => {
            caseblock.cases.forEach(c => {
                if (typeof c === 'boolean') {
                    // default case
                    return;
                }
                const case_value = c.resolveExpression(vi);
                if (case_value instanceof JavaType || case_value instanceof NumberLiteral) {
                    if (test_type && !isTypeAssignable(test_type, case_value)) {
                        const case_type = case_value instanceof JavaType ? case_value : case_value.type;
                        vi.problems.push(ParseProblem.Error(c.tokens, `Incomparable types: expression of type '${case_type.fullyDottedTypeName}' is not comparable with type '${test_type.fullyDottedTypeName}'`));
                    }
                } else {
                    vi.problems.push(ParseProblem.Error(c.tokens, `Expression expected`));
                }
            })
        })

        vi.statementStack.shift();
    }
}

exports.SwitchStatement = SwitchStatement;
