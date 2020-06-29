/**
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('./Block').Block} Block
 * @typedef {import('../body-types').Local} Local
 */
const { KeywordStatement } = require("./KeywordStatement");
const { ResolvedIdent } = require('../body-types');
const { Block } = require('./Block');

class TryStatement extends KeywordStatement {
    /** @type {(ResolvedIdent|Local[])[]} */
    resources = [];
    /** @type {Block} */
    block = null;
    catches = [];

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        this.resources.forEach(r => {
            if (r instanceof ResolvedIdent) {
                r.resolveExpression(vi);
            }
        });
        
        if (this.block) {
            vi.statementStack.unshift('try');
            this.block.validate(vi);
            vi.statementStack.shift();
        }

        this.catches.forEach(c => {
            if (c instanceof Block) {
                // finally
                c.validate(vi);
            } else if (c.block) {
                // catch block
                c.block.validate(vi);
            }
        })
    }
}

exports.TryStatement = TryStatement;
