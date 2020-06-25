/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../source-types').SourceMethodLike} SourceMethodLike
 */
const { KeywordStatement } = require("./KeywordStatement");
const ParseProblem = require('../parsetypes/parse-problem');

class ContinueStatement extends KeywordStatement {
    /** @type {Token} */
    target = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (!vi.statementStack.find(s => /^(for|do|while)$/.test(s))) {
            vi.problems.push(ParseProblem.Error(this.keyword, `continue can only be specified inside loop statements`));
        }
    }
}

exports.ContinueStatement = ContinueStatement;
