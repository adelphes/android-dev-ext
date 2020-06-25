/**
 * @typedef {import('./Statement').Statement} Statement
 * @typedef {import('../body-types').Local} Local
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { KeywordStatement } = require("./KeywordStatement");
const { checkNonVarDeclStatement } = require('../statement-validater');

class ForStatement extends KeywordStatement {
    /** @type {ResolvedIdent[] | Local[]} */
    init = null;
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {ResolvedIdent[]} */
    update = null;
    /** @type {ResolvedIdent} */
    iterable = null;
    /** @type {Statement} */
    statement = null;

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {

        if (this.statement) {
            vi.statementStack.unshift('for');
            checkNonVarDeclStatement(this.statement, vi);
            vi.statementStack.shift();
        }
    }
}

exports.ForStatement = ForStatement;
