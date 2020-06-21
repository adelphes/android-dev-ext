/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 */
const { Statement } = require("./Statement");
const ParseProblem = require('../parsetypes/parse-problem');

class BreakStatement extends Statement {
    /** @type {Token} */
    target = null;

    /**
     * @param {Token} token 
     */
    constructor(token) {
        super();
        this.break_token = token;
    }

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (!vi.statementStack.find(s => /^(for|do|while|switch)$/.test(s))) {
            vi.problems.push(ParseProblem.Error(this.break_token, `break can only be specified inside loop/switch statements`));
        }
    }
}

exports.BreakStatement = BreakStatement;
