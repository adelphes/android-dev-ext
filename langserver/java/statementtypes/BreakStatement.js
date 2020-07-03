/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../source-types').SourceMethodLike} SourceMethodLike
 */
const { KeywordStatement } = require("./KeywordStatement");
const ParseProblem = require('../parsetypes/parse-problem');

class BreakStatement extends KeywordStatement {
    /** @type {Token} */
    target = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (!vi.statementStack.find(s => /^(for|do|while|switch)$/.test(s))) {
            vi.problems.push(ParseProblem.Error(this.keyword, `break can only be specified inside loop/switch statements`));
        }
    }
}

exports.BreakStatement = BreakStatement;
