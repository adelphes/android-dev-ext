/**
 * @typedef {import('./Statement').Statement} Statement
 * @typedef {import('../body-types').Local} Local
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { KeywordStatement } = require("./KeywordStatement");
const { checkNonVarDeclStatement } = require('../statement-validater');
const { Local, ResolvedIdent } = require('../body-types');

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
        if (this.init) {
            this.init.forEach(x => {
                if (x instanceof ResolvedIdent) {
                    x.resolveExpression(vi);
                } else if (x instanceof Local) {
                    if (x.init) {
                        x.init.resolveExpression(vi);
                    }
                }
            })
        }
        if (this.test) {
            this.test.resolveExpression(vi);
        }
        if (this.update) {
            this.update.forEach(e => e.resolveExpression(vi));
        }
        if (this.iterable) {
            this.iterable.resolveExpression(vi);
        }
        if (this.statement) {
            vi.statementStack.unshift('for');
            checkNonVarDeclStatement(this.statement, vi);
            vi.statementStack.shift();
        }
    }
}

exports.ForStatement = ForStatement;
