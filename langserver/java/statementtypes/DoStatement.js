/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../expressiontypes/Expression').Expression} Expression
 * @typedef {import('../statementtypes/Block').Block} Block
 */
const { KeywordStatement } = require("./KeywordStatement");
const { checkBooleanBranchCondition } = require('../expression-resolver');

class DoStatement extends KeywordStatement {
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {Block} */
    block = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (this.block) {
            vi.statementStack.unshift('do');
            this.block.validate(vi);
            vi.statementStack.shift();
        }
        const value = this.test.resolveExpression(vi);
        checkBooleanBranchCondition(value, () => this.test.tokens, vi.problems);
    }
}

exports.DoStatement = DoStatement;
