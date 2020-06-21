/**
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('./Block').Block} Block
 * @typedef {import('../body-types').Local} Local
 */
const { Statement } = require("./Statement");
const { ResolvedIdent } = require('../body-types');
const ParseProblem = require('../parsetypes/parse-problem');

class TryStatement extends Statement {
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
    }
}

exports.TryStatement = TryStatement;
