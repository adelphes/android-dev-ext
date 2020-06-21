/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { Statement } = require("./Statement");
const ParseProblem = require('../parsetypes/parse-problem');

class ContinueStatement extends Statement {
    /** @type {Token} */
    target = null;

    /**
     * @param {Token} token 
     */
    constructor(token) {
        super();
        this.continue_token = token;
    }

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (!vi.statementStack.find(s => /^(for|do|while)$/.test(s))) {
            vi.problems.push(ParseProblem.Error(this.continue_token, `continue can only be specified inside loop statements`));
        }
    }
}

exports.ContinueStatement = ContinueStatement;
